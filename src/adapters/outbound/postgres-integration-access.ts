import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
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
  constructor(private pool: Pick<pg.Pool, 'query'>) {}
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS integration_credentials (
      id UUID PRIMARY KEY, digest TEXT NOT NULL UNIQUE, value JSONB NOT NULL
    )`);
  }
  async insert(value: IntegrationCredential, digest: string) {
    await this.pool.query('INSERT INTO integration_credentials(id,digest,value) VALUES($1,$2,$3)', [
      value.id,
      digest,
      JSON.stringify(value),
    ]);
  }
  async find(digest: string): Promise<IntegrationCredential | undefined> {
    return (
      await this.pool.query('SELECT value FROM integration_credentials WHERE digest=$1', [digest])
    ).rows[0]?.value;
  }
  async list(offset: number, limit: number) {
    const items = await this.pool.query(
      'SELECT value FROM integration_credentials ORDER BY id LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    return {
      items: items.rows.map((row) => row.value as IntegrationCredential),
      total: Number(
        (await this.pool.query('SELECT count(*) FROM integration_credentials')).rows[0].count,
      ),
    };
  }
  async revoke(id: string, at: string) {
    await this.pool.query(
      "UPDATE integration_credentials SET value=jsonb_set(value,'{revokedAt}',to_jsonb($2::text)) WHERE id=$1 AND value->>'revokedAt' IS NULL",
      [id, at],
    );
  }
}
