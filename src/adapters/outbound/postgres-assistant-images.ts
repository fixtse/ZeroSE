import { and, eq, sql } from 'drizzle-orm';
import { assistantImages } from './database-schema.js';
import { type Database } from './database.js';
import type { AssistantImageRepository } from '../../application/assistant-images.js';

/** Image data is separate from definitions, prompts and per-turn resolution. */
export class PostgresAssistantImages implements AssistantImageRepository {
  constructor(private db: Database) {}
  async initialize() {}
  async get(id: string) {
    const [row] = await this.db
      .select({ image: assistantImages.image, revision: assistantImages.revision })
      .from(assistantImages)
      .where(eq(assistantImages.assistantId, id));
    return row || { image: null, revision: 0 };
  }
  async save(id: string, image: string | null, revision: number) {
    const selection = { image: assistantImages.image, revision: assistantImages.revision };
    const rows =
      revision === 0
        ? await this.db
            .insert(assistantImages)
            .values({ assistantId: id, image })
            .onConflictDoNothing()
            .returning(selection)
        : await this.db
            .update(assistantImages)
            .set({ image, revision: sql`${assistantImages.revision} + 1` })
            .where(and(eq(assistantImages.assistantId, id), eq(assistantImages.revision, revision)))
            .returning(selection);
    return rows[0];
  }
}
