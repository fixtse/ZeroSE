import { and, eq, sql } from 'drizzle-orm';
import { serviceSettings } from './database-schema.js';
import { type SqlExecutor } from './database.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { ServiceConfig, ServiceSettingsPort } from '../../application/service-settings.js';

export class PostgresServiceSettings implements ServiceSettingsPort {
  private key: Buffer;
  constructor(
    private db: SqlExecutor,
    secret: string,
  ) {
    this.key = createHash('sha256')
      .update('assistant-services-v1:' + secret)
      .digest();
  }
  private encrypt(value: ServiceConfig) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('service-settings'));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((v) => v.toString('base64')).join('.');
  }
  async initialize(value: ServiceConfig) {
    await this.db
      .insert(serviceSettings)
      .values({ id: true, revision: 1, value: this.encrypt(value) })
      .onConflictDoNothing();
  }
  async read() {
    const [row] = await this.db.select().from(serviceSettings).where(eq(serviceSettings.id, true));
    const [iv, tag, data] = row.value.split('.').map((v: string) => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('service-settings'));
    cipher.setAuthTag(tag);
    return {
      value: JSON.parse(
        Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'),
      ) as ServiceConfig,
      revision: row.revision,
    };
  }
  async update(revision: number, value: ServiceConfig) {
    const rows = await this.db
      .update(serviceSettings)
      .set({ revision: sql`${serviceSettings.revision} + 1`, value: this.encrypt(value) })
      .where(and(eq(serviceSettings.id, true), eq(serviceSettings.revision, revision)))
      .returning({ revision: serviceSettings.revision });
    return rows.length === 1;
  }
}
