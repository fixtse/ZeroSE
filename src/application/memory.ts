import type { Config } from '../domain/config.js';
import type { MemoryFragment, MemorySearchResult } from '../domain/models.js';
import type { MemoryRepository, EmbeddingsPort, MemoryPort, MemoryReranker } from './ports.js';
import { jsonPage, MEMORY_SEARCH_TOKENS, tokens } from './context-budget.js';

function duplicateKey(text: string) {
  // Preserve word order, names, attribution, negations, dates and quantities. Only
  // punctuation, case and articles are ignored; semantic similarity alone is unsafe.
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[+-]?\p{N}+(?:[.,:/-]\p{N}+)*|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[\p{S}%?]/gu) || []
  )
    .filter((word) => !['a', 'an', 'the', 'el', 'la', 'los', 'las', 'un', 'una'].includes(word))
    .join(' ');
}

export class Memory implements MemoryPort {
  constructor(
    private config: Config['memory'],
    private repository: MemoryRepository,
    private embeddings: EmbeddingsPort,
    private reranker?: MemoryReranker,
  ) {}
  private get disabled() {
    return this.config.mode === 'none';
  }
  private async embeddingProvider() {
    if (this.disabled || this.config.mode === 'simple') return undefined;
    const provider = this.embeddings.resolve ? await this.embeddings.resolve() : this.embeddings;
    return provider.enabled ? provider : undefined;
  }
  async save(session: string, value: MemoryFragment, source?: string, signal?: AbortSignal) {
    if (this.disabled) throw new Error('Long-term memory is disabled for this chat');
    if (
      value.expiresAt &&
      (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now())
    )
      throw new Error('Memory expiration must be a future ISO timestamp');
    const provider = await this.embeddingProvider();
    const embedding = provider
      ? await provider.embed(value.text, 'RETRIEVAL_DOCUMENT', signal)
      : null;
    await this.repository.insertMemory(
      this.config.sharedProfile || session,
      value,
      embedding,
      source,
      provider?.space,
    );
    return { saved: true };
  }
  async search(
    session: string,
    query: string,
    categories: string[] = [],
    start?: string,
    end?: string,
    signal?: AbortSignal,
  ): Promise<MemorySearchResult[]> {
    if (this.disabled) return [];
    const provider = await this.embeddingProvider();
    const vector = provider ? await provider.embed(query, 'RETRIEVAL_QUERY', signal) : undefined;
    let candidates = await this.repository.searchMemory(
      this.config.sharedProfile || session,
      query,
      vector,
      categories,
      start,
      end,
      provider?.space,
    );
    candidates = candidates.filter(
      (candidate) =>
        !candidate.metadata.expires_at || Date.parse(candidate.metadata.expires_at) > Date.now(),
    );
    if (this.reranker && candidates.length > 1)
      candidates = await this.reranker.rank(session, query, candidates, signal);
    const selected: MemorySearchResult[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.metadata.expires_at && Date.parse(candidate.metadata.expires_at) <= Date.now())
        continue;
      const key = duplicateKey(candidate.text);
      if (seen.has(key)) continue;
      seen.add(key);
      const summary = candidate.summary || candidate.text;
      const excerpt = summary.length > 480;
      const result: MemorySearchResult = {
        id: candidate.id,
        summary: excerpt
          ? [...summary].slice(0, 480).join('') + '… [excerpt; use memory_read]'
          : summary,
        summary_is_excerpt: excerpt,
        metadata: {
          category: candidate.metadata.category,
          tags: candidate.metadata.tags,
          created_at: candidate.metadata.created_at,
          ...(candidate.metadata.expires_at ? { expires_at: candidate.metadata.expires_at } : {}),
        },
        similarity: candidate.similarity,
      };
      // Never truncate provenance to squeeze a record into the context budget.
      if (tokens([...selected, result]) > MEMORY_SEARCH_TOKENS) continue;
      selected.push(result);
      if (selected.length === 3) break;
    }
    return selected;
  }
  async read(session: string, id: string, offset = 0) {
    if (this.disabled) throw new Error('Long-term memory is disabled for this chat');
    if (!/^[1-9]\d{0,18}$/.test(id)) throw new Error('Invalid memory ID');
    const value = await this.repository.readMemory(this.config.sharedProfile || session, id);
    if (
      !value ||
      (value.metadata.expires_at && Date.parse(value.metadata.expires_at) <= Date.now())
    )
      throw new Error('Memory not found in this profile');
    return jsonPage(
      {
        id: value.id,
        text: value.text,
        metadata: value.metadata,
        superseded_by: value.superseded_by,
      },
      offset,
    );
  }
  async catalog(session: string) {
    if (this.disabled) return { categories: [], tags: [] };
    const catalog = await this.repository.memoryCatalog(this.config.sharedProfile || session);
    return {
      categories: [...new Set(catalog.categories)],
      tags: catalog.tags,
    };
  }
}
