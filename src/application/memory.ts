import type { Config } from '../domain/config.js';
import type { MemoryFragment, MemorySearchResult } from '../domain/models.js';
import type { MemoryRepository, EmbeddingsPort, MemoryPort } from './ports.js';
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
  ) {}
  async save(session: string, value: MemoryFragment, source?: string, signal?: AbortSignal) {
    const embedding = this.embeddings.enabled
      ? await this.embeddings.embed(value.text, 'RETRIEVAL_DOCUMENT', signal)
      : null;
    await this.repository.insertMemory(
      this.config.sharedProfile || session,
      value,
      embedding,
      source,
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
    const vector = this.embeddings.enabled
      ? await this.embeddings.embed(query, 'RETRIEVAL_QUERY', signal)
      : undefined;
    const candidates = await this.repository.searchMemory(
      this.config.sharedProfile || session,
      query,
      vector,
      categories,
      start,
      end,
    );
    const selected: MemorySearchResult[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
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
        metadata: candidate.metadata,
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
    if (!/^[1-9]\d{0,18}$/.test(id)) throw new Error('Invalid memory ID');
    const value = await this.repository.readMemory(this.config.sharedProfile || session, id);
    if (!value) throw new Error('Memory not found in this profile');
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
    const catalog = await this.repository.memoryCatalog(this.config.sharedProfile || session);
    return {
      categories: [...new Set([...this.config.categories, ...catalog.categories])],
      tags: catalog.tags,
    };
  }
  pending(session: string) {
    return this.repository.pendingMemoryMessages(session);
  }
  pendingSessions() {
    return this.repository.pendingMemorySessions();
  }
  async consolidate(
    session: string,
    fragments: MemoryFragment[],
    ids: number[],
    signal?: AbortSignal,
  ) {
    const source = ids.join(',');
    for (let index = 0; index < fragments.length; index++)
      await this.save(session, fragments[index], `${session}:${source}:${index}`, signal);
    await this.repository.markConsolidated(session, ids);
  }
}
