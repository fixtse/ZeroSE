import type { Config } from '../domain/config.js';
import type { MemoryFragment, MemoryMatch } from '../domain/models.js';
import type { MemoryRepository, EmbeddingsPort, MemoryPort } from './ports.js';

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
  ): Promise<MemoryMatch[]> {
    const vector = this.embeddings.enabled
      ? await this.embeddings.embed(query, 'SEMANTIC_SIMILARITY', signal)
      : undefined;
    return this.repository.searchMemory(
      this.config.sharedProfile || session,
      query,
      vector,
      categories,
      start,
      end,
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
