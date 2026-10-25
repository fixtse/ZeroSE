import type pg from 'pg';
import type { AssistantImageRepository } from '../../application/assistant-images.js';

/** Image data is separate from definitions, prompts and per-turn resolution. */
export class PostgresAssistantImages implements AssistantImageRepository {
  constructor(private pool: pg.Pool) {}
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS assistant_images (
      assistant_id TEXT PRIMARY KEY REFERENCES assistant_definitions(id) ON DELETE CASCADE,
      image TEXT, revision INTEGER NOT NULL DEFAULT 1
    )`);
  }
  async get(id: string) {
    const { rows } = await this.pool.query('SELECT image,revision FROM assistant_images WHERE assistant_id=$1', [id]);
    return rows[0] || { image: null, revision: 0 };
  }
  async save(id: string, image: string | null, revision: number) {
    const { rows } = revision === 0
      ? await this.pool.query('INSERT INTO assistant_images(assistant_id,image) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING image,revision', [id,image])
      : await this.pool.query('UPDATE assistant_images SET image=$1,revision=revision+1 WHERE assistant_id=$2 AND revision=$3 RETURNING image,revision', [image,id,revision]);
    return rows[0];
  }
}
