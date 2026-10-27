import pg from 'pg';
import { migrateDatabase } from '../src/adapters/outbound/database-migrations.js';

const url = process.env.ASSISTANT_DATABASE_URL;
if (!url) throw new Error('Set ASSISTANT_DATABASE_URL to the intended database');
const pool = new pg.Pool({ connectionString: url });
try {
  await migrateDatabase(pool);
  console.log('Database migrations applied. Existing records were retained.');
} finally {
  await pool.end();
}
