import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Store } from '../src/adapters/outbound/postgres-store.js';
import { importSqlite } from '../src/adapters/outbound/sqlite-import.js';

test('database lease rejects a second process and parallel claims keep sessions exclusive', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => Store.open(f.url, 2, f.schema), /already owns/);
    const jobs = await Promise.all(
      Array.from({ length: 8 }, () => f.store.enqueue('one', { kind: 'chat' }, 'same')),
    );
    assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
    await f.store.enqueue('one', { kind: 'chat' });
    const other = await f.store.enqueue('two', { kind: 'chat' });
    const claims = await Promise.all(Array.from({ length: 6 }, () => f.store.claim([])));
    assert.deepEqual(
      new Set(claims.filter(Boolean).map((job) => job!.id)),
      new Set([jobs[0].id, other.id]),
    );
  } finally {
    await f.close();
  }
});
test('3072-dimensional search uses halfvec candidates and full precision scoring', async () => {
  const f = await fixture(3072);
  const vector = Array.from({ length: 3072 }, (_, i) => (i === 0 ? 1 : 0));
  try {
    await f.store.insertMemory(
      'owner',
      { text: 'memory about trade', category: 'Trading', tags: ['idea'] },
      vector,
      'one',
    );
    await f.store.insertMemory(
      'other',
      { text: 'private trade', category: 'Trading', tags: [] },
      vector,
      'two',
    );
    await f.store.insertMemory(
      'owner',
      { text: 'trade without vector', category: 'Ideas', tags: [] },
      null,
      'three',
    );
    const found = await f.store.searchMemory('owner', 'trade', vector, ['Trading']);
    assert.equal(found.length, 1);
    assert.equal(found[0].similarity, 1);
    assert.equal(
      (await f.store.searchMemory('owner', 'trade', vector, [], '2100-01-01')).length,
      0,
    );
    assert.equal((await f.store.searchMemory('owner', 'trade', undefined, [])).length, 2);
    const client = await f.store.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan=off');
      const plan = await client.query(
        'EXPLAIN SELECT id FROM memories ORDER BY embedding::halfvec(3072) <=> $1::halfvec(3072) LIMIT 100',
        [JSON.stringify(vector)],
      );
      assert.match(JSON.stringify(plan.rows), /memories_embedding/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await f.close();
  }
});
test('SQLite import verifies all state, advances identities and refuses overwriting a target', async () => {
  const f = await fixture();
  const file = join(f.dir, 'source.sqlite'),
    db = new DatabaseSync(file);
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,session TEXT,dedupe TEXT,payload TEXT,status TEXT,output TEXT,error TEXT,created TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,thread TEXT,history_after INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session TEXT,role TEXT,text TEXT,consolidated INTEGER,created TEXT);
    CREATE TABLE memories(id INTEGER PRIMARY KEY,session TEXT,text TEXT,category TEXT,tags TEXT,embedding TEXT,source TEXT,created TEXT);
    CREATE TABLE audit(id INTEGER PRIMARY KEY,job TEXT,tool TEXT,success INTEGER,duration INTEGER,created TEXT);
    CREATE TABLE schedules(key TEXT PRIMARY KEY,created TEXT);
    CREATE TABLE cursors(name TEXT PRIMARY KEY,value INTEGER);
    INSERT INTO jobs VALUES('j1','one','dedupe','{"kind":"chat","text":"hello"}','done','output',NULL,'2026-10-16 10:00:00');
    INSERT INTO sessions VALUES('one','thread',8);
    INSERT INTO messages VALUES(9,'one','user','hello',1,'2026-10-16 10:00:00');
    INSERT INTO memories VALUES(12,'one','fact','Ideas','["tag"]','[0.123456789,1]','fact1','2026-10-16 10:00:00');
    INSERT INTO audit VALUES(3,'j1','read',1,5,'2026-10-16 10:00:00');
    INSERT INTO schedules VALUES('morning:today','2026-10-16 10:00:00');
    INSERT INTO cursors VALUES('telegram',42);`);
  db.close();
  try {
    const corrupt = new DatabaseSync(file);
    corrupt.exec("UPDATE memories SET embedding='[1,0,0]'");
    await assert.rejects(() => importSqlite(file, f.store), /dimensions/);
    assert.equal(Number((await f.store.pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n), 0);
    corrupt.exec("UPDATE memories SET embedding='[0.123456789,1]'");
    corrupt.close();
    assert.deepEqual(await importSqlite(file, f.store), {
      jobs: 1,
      sessions: 1,
      messages: 1,
      memories: 1,
      audit: 1,
      schedules: 1,
      cursors: 1,
    });
    assert.equal(await f.store.cursor('telegram'), 42);
    assert.equal(await f.store.thread('one'), 'thread');
    assert.equal((await f.store.history('one')).length, 1);
    await f.store.addMessage('one', 'user', 'new');
    assert.equal(
      Number((await f.store.pool.query('SELECT max(id) AS id FROM messages')).rows[0].id),
      10,
    );
    await assert.rejects(() => importSqlite(file, f.store), /empty target/);
    assert.equal((await f.store.job('j1'))?.output, 'output');
  } finally {
    await f.close();
  }
});
