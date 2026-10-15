import { Pool } from 'pg';
import type { LegacyMemoryPort } from '../../application/ports.js';
import type { MemoryMatch } from '../../domain/models.js';
export class PostgresMemory implements LegacyMemoryPort {
  private pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 3,
      statement_timeout: 15_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  async search(
    vector: number[],
    categories: string[],
    start?: string,
    end?: string,
    signal?: AbortSignal,
  ): Promise<MemoryMatch[]> {
    signal?.throwIfAborted();
    const result = await this.pool.query(
      `SELECT text,metadata,1-(embedding <=> $1::vector) AS similarity
      FROM documents_pg WHERE 1-(embedding <=> $1::vector)>0.4
      AND (cardinality($2::text[])=0 OR metadata->>'category'=ANY($2::text[]))
      AND ($3::timestamp IS NULL OR (metadata->>'created_at')::timestamp >= $3::timestamp)
      AND ($4::timestamp IS NULL OR (metadata->>'created_at')::timestamp <= $4::timestamp)
      ORDER BY embedding <=> $1::vector LIMIT 10`,
      [JSON.stringify(vector), categories, start || null, end || null],
    );
    return result.rows;
  }
  async close() {
    await this.pool.end();
  }
}
