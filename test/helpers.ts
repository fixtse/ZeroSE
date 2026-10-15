import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import { Store } from '../src/adapters/outbound/postgres-store.js';
export async function fixture(dimensions = 2) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error('Set TEST_DATABASE_URL to an isolated PostgreSQL database with pgvector');
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: url });
  // Install the extension outside the disposable schemas used by concurrent tests.
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const dir = mkdtempSync(join(tmpdir(), 'fixt-assistant-'));
  const config = ConfigSchema.parse({
    apiKey: 'test-key-that-is-long-enough',
    dataDir: dir,
    database: { url },
    memory: { embeddingDimensions: dimensions },
    codex: { home: join(dir, 'codex') },
  });
  const store = await Store.open(url, dimensions, schema);
  return {
    dir,
    config,
    store,
    url,
    schema,
    async close() {
      await store.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export async function until(condition: () => boolean | Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('Test condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
