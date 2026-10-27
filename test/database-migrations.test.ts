import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateDatabase } from '../src/adapters/outbound/database-migrations.js';

async function isolatedDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Set TEST_DATABASE_URL to an isolated PostgreSQL database');
  const schema = 'upgrade_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test('existing pre-cleanup database upgrades without losing saved assistant data', async () => {
  const f = await isolatedDatabase();
  try {
    await migrateDatabase(f.pool);
    await f.pool.query(`
      DELETE FROM __drizzle_migrations WHERE created_at>=1793116800000;
      ALTER TABLE access_profiles DROP COLUMN respond_to_replies;
      UPDATE __drizzle_migrations SET hash='15d0bed3f76f30026a155a50e6abeee740a95c54a1ebadb10103cad4008d3fcd' WHERE created_at=1793064686202;
      ALTER TABLE assistant_definitions DROP CONSTRAINT assistant_definitions_preset_check;
      ALTER TABLE access_profiles DROP CONSTRAINT access_profiles_prompt_preset_check;
      INSERT INTO assistant_definitions(id,name,prompt,preset,builtin) VALUES
        ('helper','Saved assistant','Private saved prompt','legacy-explicit',true);
      INSERT INTO access_profiles(bot,chat_id,kind,label,assistant_id,prompt_preset)
        VALUES ('helper','42','user','Saved user','helper','legacy-explicit');
    `);
    await migrateDatabase(f.pool);
    await migrateDatabase(f.pool);
    const {
      rows: [assistant],
    } = await f.pool.query(
      "SELECT name,prompt,preset,builtin FROM assistant_definitions WHERE id='helper'",
    );
    assert.deepEqual(assistant, {
      name: 'Saved assistant',
      prompt: 'Private saved prompt',
      preset: 'explicit',
      builtin: false,
    });
    const {
      rows: [profile],
    } = await f.pool.query(
      "SELECT assistant_id,prompt_preset,respond_to_replies FROM access_profiles WHERE bot='helper'",
    );
    assert.deepEqual(profile, {
      assistant_id: 'helper',
      prompt_preset: 'explicit',
      respond_to_replies: true,
    });
    const {
      rows: [history],
    } = await f.pool.query('SELECT count(*)::int AS count FROM __drizzle_migrations');
    assert.equal(history.count, 6);
  } finally {
    await f.close();
  }
});

test('unexpected migration checksums are still rejected before any upgrade', async () => {
  const f = await isolatedDatabase();
  try {
    await migrateDatabase(f.pool);
    await f.pool.query(
      "UPDATE __drizzle_migrations SET hash='unrecognized' WHERE created_at=1793064686202",
    );
    await assert.rejects(migrateDatabase(f.pool), /history does not match/);
  } finally {
    await f.close();
  }
});
