import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { integrationCredentials as credentials } from './database-schema.js';
import { type SqlExecutor } from './database.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  IntegrationCredentialRepository,
  CredentialCrypto,
} from '../../application/integration-access.js';
import type { IntegrationCredential } from '../../domain/integration-access.js';
export const credentialCrypto: CredentialCrypto = {
  id: randomUUID,
  secret: () => randomBytes(32).toString('hex'),
  digest: (value) => createHash('sha256').update(value).digest('hex'),
};
export class PostgresIntegrationAccess implements IntegrationCredentialRepository {
  constructor(private db: SqlExecutor) {}
  async initialize() {}
  async insert(value: IntegrationCredential, digest: string) {
    await this.db.insert(credentials).values({ id: value.id, digest, value });
  }
  async find(digest: string): Promise<IntegrationCredential | undefined> {
    const [row] = await this.db
      .select({ value: credentials.value })
      .from(credentials)
      .where(eq(credentials.digest, digest));
    return row?.value;
  }
  async list(offset: number, limit: number) {
    const items = await this.db
      .select({ value: credentials.value })
      .from(credentials)
      .orderBy(credentials.id)
      .limit(limit)
      .offset(offset);
    const [{ total }] = await this.db.select({ total: count() }).from(credentials);
    return { items: items.map((row) => row.value), total };
  }
  async revoke(id: string, at: string) {
    await this.db
      .update(credentials)
      .set({ value: sql`jsonb_set(${credentials.value}, '{revokedAt}', to_jsonb(${at}::text))` })
      .where(and(eq(credentials.id, id), isNull(sql`${credentials.value}->>'revokedAt'`)));
  }
}
