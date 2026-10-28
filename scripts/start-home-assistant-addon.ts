import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// The add-on's /data directory is private and persistent across upgrades.
process.umask(0o077);
const options = JSON.parse(await readFile('/data/options.json', 'utf8'));
const backend = options.database_backend || 'postgres';
if (backend !== 'postgres' && backend !== 'pglite')
  throw new Error('database_backend must be postgres or pglite');
if (
  backend === 'postgres' &&
  (typeof options.database_url !== 'string' || !/^postgres(?:ql)?:\/\//.test(options.database_url))
)
  throw new Error('Configure database_url with a PostgreSQL + pgvector database.');
if (backend === 'pglite' && options.database_url)
  throw new Error('Clear database_url before choosing PGlite; existing data is not migrated.');
process.env.ASSISTANT_DATABASE_BACKEND = backend;
await mkdir('/data/zero', { recursive: true, mode: 0o700 });
const keyFile = '/data/zero/bootstrap-key';
try {
  await writeFile(keyFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}
process.env.ASSISTANT_API_KEY = (await readFile(keyFile, 'utf8')).trim();
process.env.ASSISTANT_SECRETS_KEY = process.env.ASSISTANT_API_KEY;
if (backend === 'postgres') process.env.ASSISTANT_DATABASE_URL = options.database_url;
else delete process.env.ASSISTANT_DATABASE_URL;
process.env.ASSISTANT_DATA_DIR = '/data/zero';
process.env.ASSISTANT_CODEX_HOME = '/data/zero/codex';
process.env.ASSISTANT_HOST = '0.0.0.0';
process.env.ASSISTANT_PORT = '8788';
process.env.ASSISTANT_HA_INGRESS = '1';
await import('../src/main.js');
