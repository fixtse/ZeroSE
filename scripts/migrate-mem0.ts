import pg from 'pg';
import { migrateDatabase } from '../src/adapters/outbound/database-migrations.js';
import { migrateMem0 } from '../src/adapters/outbound/mem0-migration.js';

const url = process.env.ASSISTANT_DATABASE_URL;
if (!url) throw new Error('Set ASSISTANT_DATABASE_URL to the intended database');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--apply')) throw new Error('Usage: pnpm memory:migrate [--apply]');
const pool = new pg.Pool({ connectionString: url });
try {
  // Schema migration is explicit too: a dry run must not create or change tables.
  if (args.includes('--apply')) await migrateDatabase(pool);
  console.log(JSON.stringify(await migrateMem0(pool, args.includes('--apply'))));
} finally {
  await pool.end();
}
