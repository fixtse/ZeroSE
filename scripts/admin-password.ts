import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/adapters/outbound/config.js';
import { AdminAuth } from '../src/adapters/inbound/admin-auth.js';

process.umask(0o077);
const args = process.argv.slice(2);
const index = args.indexOf('--password-file');
if (
  index < 0 ||
  !args[index + 1] ||
  args.some((arg, i) => i !== index && i !== index + 1 && arg !== '--reset')
)
  throw new Error('Usage: admin-password --password-file /private/password.txt [--reset]');
process.loadEnvFile(resolve('.env'));
if (!process.env.ASSISTANT_DATABASE_URL) {
  const database = new URL('postgresql://assistant@127.0.0.1/assistant');
  database.password = process.env.ASSISTANT_POSTGRES_PASSWORD || '';
  database.port = process.env.ASSISTANT_POSTGRES_PORT || '55432';
  process.env.ASSISTANT_DATABASE_URL = database.href;
}
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.database.url });
try {
  const auth = new AdminAuth(
    pool,
    process.env.ASSISTANT_ADMIN_URL || 'http://127.0.0.1:8788',
    process.env.ASSISTANT_SECRETS_KEY || config.apiKey,
  );
  await auth.initialize();
  const password = (await readFile(resolve(args[index + 1]), 'utf8')).replace(/\r?\n$/, '');
  await auth.provision(password, args.includes('--reset'));
  console.log(
    'Administrator fixt provisioned. Sign in and change the password from the web interface.',
  );
} finally {
  await pool.end();
}
