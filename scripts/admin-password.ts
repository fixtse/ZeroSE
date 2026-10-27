import { createDatabase } from '../src/adapters/outbound/database.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadRuntimeConfig } from '../src/adapters/outbound/runtime-config.js';
import { AdminAuth } from '../src/adapters/inbound/admin-auth.js';

process.umask(0o077);
const args = process.argv.slice(2);
const index = args.indexOf('--password-file');
const userIndex = args.indexOf('--username');
if (
  userIndex < 0 ||
  !args[userIndex + 1] ||
  index < 0 ||
  !args[index + 1] ||
  args.some(
    (arg, i) =>
      i !== index && i !== index + 1 && i !== userIndex && i !== userIndex + 1 && arg !== '--reset',
  )
)
  throw new Error(
    'Usage: admin-password --username USERNAME --password-file /private/password.txt [--reset]',
  );
process.loadEnvFile(resolve('.env'));
if (!process.env.ASSISTANT_DATABASE_URL) {
  const database = new URL('postgresql://assistant@127.0.0.1/assistant');
  database.password = process.env.ASSISTANT_POSTGRES_PASSWORD || '';
  database.port = process.env.ASSISTANT_POSTGRES_PORT || '55432';
  process.env.ASSISTANT_DATABASE_URL = database.href;
}
const config = await loadRuntimeConfig();
const pool = new pg.Pool({ connectionString: config.database.url });
try {
  const auth = new AdminAuth(
    createDatabase(pool),
    process.env.ASSISTANT_ADMIN_URL || 'http://127.0.0.1:8788',
    process.env.ASSISTANT_SECRETS_KEY || config.apiKey,
  );
  await auth.initialize();
  const password = (await readFile(resolve(args[index + 1]), 'utf8')).replace(/\r?\n$/, '');
  await auth.provision(password, args.includes('--reset'), args[userIndex + 1]);
  console.log('Administrator provisioned. Sign in and change the password from the web interface.');
} finally {
  await pool.end();
}
