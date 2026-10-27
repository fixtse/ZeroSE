import { and, eq, sql } from 'drizzle-orm';
import { aiSettings, aiNextModels } from './database-schema.js';
import { type SqlExecutor } from './database.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AISettings, AISettingsPort } from '../../domain/ai.js';

export class PostgresAI implements AISettingsPort {
  private key: Buffer;
  constructor(
    private db: SqlExecutor,
    secret: string,
  ) {
    this.key = createHash('sha256')
      .update('assistant-ai-v1:' + secret)
      .digest();
  }
  private encrypt(value: AISettings) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('ai-settings'));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((v) => v.toString('base64')).join('.');
  }
  async initialize(model: string) {
    const initial: AISettings = {
      revision: 1,
      providers: [{ id: 'codex', name: 'Codex CLI', kind: 'codex', baseUrl: '', apiKey: '' }],
      models: [{ id: 'codex-default', label: model, provider: 'codex', model }],
      defaultModel: 'codex-default',
    };
    await this.db
      .insert(aiSettings)
      .values({ id: true, revision: 1, value: this.encrypt(initial) })
      .onConflictDoNothing();
  }
  async read(): Promise<AISettings> {
    const [row] = await this.db.select().from(aiSettings).where(eq(aiSettings.id, true));
    const [iv, tag, data] = row.value.split('.').map((v: string) => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('ai-settings'));
    cipher.setAuthTag(tag);
    return {
      ...JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8')),
      revision: row.revision,
    };
  }
  async update(value: AISettings) {
    const rows = await this.db
      .update(aiSettings)
      .set({ revision: sql`${aiSettings.revision} + 1`, value: this.encrypt(value) })
      .where(and(eq(aiSettings.id, true), eq(aiSettings.revision, value.revision)))
      .returning({ revision: aiSettings.revision });
    return rows.length === 1;
  }
  async selectNext(session: string, model: string | null) {
    if (model === null) await this.db.delete(aiNextModels).where(eq(aiNextModels.session, session));
    else
      await this.db
        .insert(aiNextModels)
        .values({ session, model })
        .onConflictDoUpdate({ target: aiNextModels.session, set: { model } });
  }
  async consumeNext(session: string) {
    const [row] = await this.db
      .delete(aiNextModels)
      .where(eq(aiNextModels.session, session))
      .returning({ model: aiNextModels.model });
    return row?.model;
  }
}
