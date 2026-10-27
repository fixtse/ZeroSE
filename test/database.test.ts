import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { databaseErrorCode, execute } from '../src/adapters/outbound/database.js';
import { schedules } from '../src/adapters/outbound/database-schema.js';
import { fixture } from './helpers.js';

test('Drizzle binds values and arrays without changing PostgreSQL result types', async () => {
  const f = await fixture();
  try {
    const value = "quotes ' and $1; DROP TABLE jobs; --";
    const result = await execute(
      f.store.db,
      sql`SELECT ${value}::text AS value,
      ${sql.param([value, 'other'])}::text[] AS items,
      ${sql.param([])}::text[] AS empty,
      ${JSON.stringify({ value })}::jsonb AS payload,
      9007199254740993::bigint AS large,
      now() AS created`,
    );
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].value, value);
    assert.deepEqual(result.rows[0].items, [value, 'other']);
    assert.deepEqual(result.rows[0].empty, []);
    assert.deepEqual(result.rows[0].payload, { value });
    assert.equal(result.rows[0].large, '9007199254740993');
    assert(result.rows[0].created instanceof Date);
    const job = await f.store.enqueue(value, { text: value });
    assert.equal(job.session, value);
    assert.deepEqual(job.payload, { text: value });
  } finally {
    await f.close();
  }
});

test('Drizzle rolls back failed transactions and exposes SQLSTATE conflicts', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.store.db.transaction(async (tx) => {
        await execute(tx, sql`INSERT INTO schedules(key) VALUES('same')`);
        await execute(tx, sql`INSERT INTO schedules(key) VALUES('same')`);
      }),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    assert.equal(await f.store.scheduled('same'), false);
    await f.store.markScheduled('same');
    assert.equal(await f.store.scheduled('same'), true);
    await assert.rejects(
      f.store.db.insert(schedules).values({ key: 'same' }),
      (error: unknown) => databaseErrorCode(error) === '23505',
    );
  } finally {
    await f.close();
  }
});

test('query builders retain exact bigint identities in queue and memory results', async () => {
  const f = await fixture();
  try {
    await f.store.pool.query("SELECT setval(pg_get_serial_sequence('jobs','sequence'),$1,true)", [
      '9007199254740992',
    ]);
    const job = await f.store.enqueue('large', { kind: 'chat' });
    assert.match(JSON.stringify(job), /"sequence":"9007199254740993"/);
    assert.deepEqual(await f.store.job(job.id), job);
    const claimed = await f.store.claim([]);
    assert.equal(claimed?.id, job.id);
    assert.match(JSON.stringify(claimed), /"sequence":"9007199254740993"/);

    await f.store.pool.query("SELECT setval(pg_get_serial_sequence('memories','id'),$1,true)", [
      '9007199254740992',
    ]);
    await f.store.insertMemory(
      'large',
      { text: 'first memory', category: 'test', tags: [] },
      null,
      'first',
    );
    const first = await f.store.readMemory('large', '9007199254740993');
    assert.equal(first?.id, '9007199254740993');
    await f.store.insertMemory(
      'large',
      { text: 'replacement memory', category: 'test', tags: [], supersedes: [first!.id] },
      null,
      'second',
    );
    assert.equal((await f.store.readMemory('large', first!.id))?.superseded_by, '9007199254740994');
    assert.equal(
      (await f.store.readMemory('large', '9007199254740994'))?.text,
      'replacement memory',
    );
  } finally {
    await f.close();
  }
});
