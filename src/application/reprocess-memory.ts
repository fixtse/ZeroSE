import type { EmbeddingsPort, MemoryEmbeddingRepository } from './ports.js';

export class ReprocessMemory {
  constructor(
    private repository: MemoryEmbeddingRepository,
    private embeddings: EmbeddingsPort,
  ) {}
  async batch(after: string) {
    const provider = this.embeddings.resolve ? await this.embeddings.resolve() : this.embeddings;
    if (!provider.enabled || !provider.space)
      throw new Error('Activa y guarda un modelo de embeddings primero.');
    const rows = await this.repository.embeddingBatch(after, 10);
    for (const row of rows) {
      const vector = await provider.embed(
        row.text,
        'RETRIEVAL_DOCUMENT',
        AbortSignal.timeout(15000),
      );
      await this.repository.replaceEmbedding(row.id, row.text, vector, provider.space);
    }
    return { processed: rows.length, after: rows.at(-1)?.id || after, done: rows.length < 10 };
  }
}
