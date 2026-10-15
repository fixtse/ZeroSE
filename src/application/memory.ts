import type { Config } from '../domain/config.js';
import type { MemoryFragment, MemoryMatch } from '../domain/models.js';
import type { MemoryRepository, EmbeddingsPort, LegacyMemoryPort, MemoryPort } from './ports.js';

export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function timestamp(value: string) {
  const iso = value.replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : iso + 'Z');
}
export class Memory implements MemoryPort {
  constructor(
    private config: Config['memory'],
    private repository: MemoryRepository,
    private embeddings: EmbeddingsPort,
    private legacy?: LegacyMemoryPort,
  ) {}
  async save(session: string, value: MemoryFragment, source?: string, signal?: AbortSignal) {
    const embedding = this.embeddings.enabled
      ? await this.embeddings.embed(value.text, 'RETRIEVAL_DOCUMENT', signal)
      : null;
    this.repository.insertMemory(this.config.sharedProfile || session, value, embedding, source);
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
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const results = this.repository
      .memories(this.config.sharedProfile || session)
      .filter(
        (row) =>
          (!categories.length || categories.includes(row.category)) &&
          (!start || timestamp(row.created) >= Date.parse(start)) &&
          (!end || timestamp(row.created) <= Date.parse(end)),
      )
      .map((row) => ({
        text: row.text,
        metadata: { category: row.category, tags: row.tags, created_at: row.created },
        similarity:
          vector && row.embedding
            ? cosine(vector, row.embedding)
            : words.filter((word) => row.text.toLocaleLowerCase().includes(word)).length /
              Math.max(words.length, 1),
      }))
      .filter((row) => row.similarity > 0.4);
    if (this.legacy && vector)
      results.push(...(await this.legacy.search(vector, categories, start, end, signal)));
    return results.sort((a, b) => b.similarity - a.similarity).slice(0, 10);
  }
  catalog(session: string) {
    const rows = this.repository.memories(this.config.sharedProfile || session);
    return {
      categories: [...new Set([...this.config.categories, ...rows.map((row) => row.category)])],
      tags: [...new Set(rows.flatMap((row) => row.tags))],
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
    this.repository.markConsolidated(session, ids);
  }
}
