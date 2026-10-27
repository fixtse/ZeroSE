import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/application/memory.js';
import { Mem0Repository, withMem0PersonalData } from '../src/adapters/outbound/mem0-repository.js';
import { migrateMem0 } from '../src/adapters/outbound/mem0-migration.js';
import { PostgresPersonalData } from '../src/adapters/outbound/postgres-personal-data.js';
import { fixture } from './helpers.js';
import pg from 'pg';
import { Store } from '../src/adapters/outbound/postgres-store.js';

test('Mem0 offline import preserves IDs, metadata, vectors, source dedupe, dates and supersessions without reviving forgotten data', async () => {
  const f = await fixture();
  let store = f.store;
  const offline = new pg.Pool({
    connectionString: f.url,
    options: `-c search_path=${f.schema},public`,
  });
  try {
    await store.insertMemory(
      'alice',
      {
        text: 'Old backup recommendation',
        category: 'Ideas',
        tags: ['backup'],
        summary: 'Previous advice',
      },
      [1, 0],
      'old',
      'test-space',
    );
    await store.insertMemory(
      'alice',
      {
        text: 'Corrected encrypted backup advice',
        category: 'Ideas',
        tags: ['encrypted'],
        supersedes: ['1'],
      },
      [1, 0],
      'new',
      'test-space',
    );
    await store.insertMemory(
      'bob',
      { text: 'Private backup destination', category: 'Private', tags: [] },
      [0, 1],
    );
    await store.insertMemory(
      'alice',
      { text: 'Forgotten secret', category: 'Private', tags: ['secret'] },
      [1, 0],
    );
    await new PostgresPersonalData(store.db).forget('alice', ['4']);
    let repo = new Mem0Repository(store.pool, 2, store);
    await assert.rejects(repo.assertMigrated(), /requires migration/);
    await store.close();
    assert.deepEqual(await migrateMem0(offline), {
      migrated: false,
      total: 4,
      active: 2,
      applied: false,
    });
    assert.equal(
      (await offline.query('SELECT count(*) FROM zero_mem0_records')).rows[0].count,
      '0',
    );
    const originalDate = (
      await offline.query('SELECT created FROM memories WHERE id=2')
    ).rows[0].created.toISOString();
    const result = await migrateMem0(offline, true);
    assert.equal(result.applied, true);
    assert.equal((await migrateMem0(offline, true)).applied, false);
    store = await Store.open(f.url, 2, f.schema);
    repo = new Mem0Repository(store.pool, 2, store);
    await repo.assertMigrated();
    assert.equal((await repo.readMemory('alice', '1'))!.superseded_by, '2');
    assert.equal((await repo.readMemory('alice', '2'))!.metadata.created_at, originalDate);
    assert.equal(await repo.readMemory('alice', '3'), undefined);
    assert.equal(await repo.readMemory('alice', '4'), undefined);
    assert.equal((await repo.searchMemory('alice', 'backup', undefined, []))[0].id, '2');
    assert.deepEqual(await repo.memoryCatalog('alice'), {
      categories: ['Ideas'],
      tags: ['encrypted'],
    });
    // Consolidation sources already imported must never be re-saved.
    await repo.insertMemory(
      'alice',
      { text: 'Do not replace', category: 'Other', tags: [] },
      null,
      'new',
    );
    assert.equal((await repo.memories('alice', '', undefined, 0, 20)).total, 1);
    const beforeReprocess = await repo.readMemory('alice', '2');
    assert.deepEqual(await repo.embeddingBatch('0', 10), [
      { id: '2', text: 'Corrected encrypted backup advice' },
      { id: '3', text: 'Private backup destination' },
    ]);
    await assert.rejects(
      repo.replaceEmbedding('2', beforeReprocess!.text, [1], 'new-space'),
      /dimensions/,
    );
    await repo.replaceEmbedding('2', beforeReprocess!.text, [0, 1], 'new-space');
    assert.deepEqual(await repo.readMemory('alice', '2'), beforeReprocess);
    const reprocessed = await store.pool.query(
      "SELECT vector::text, payload->>'embedding_space' AS space FROM zero_mem0_vectors WHERE payload->>'zero_id'='2'",
    );
    assert.equal(reprocessed.rows[0].vector, '[0,1]');
    assert.equal(reprocessed.rows[0].space, 'new-space');
    await repo.replaceEmbedding('2', 'stale text', [1, 0], 'stale-space');
    assert.equal(
      (
        await store.pool.query(
          "SELECT payload->>'embedding_space' AS space FROM zero_mem0_vectors WHERE payload->>'zero_id'='2'",
        )
      ).rows[0].space,
      'new-space',
    );
    const data = withMem0PersonalData(repo, new PostgresPersonalData(store.db));
    await assert.rejects(data.forget('alice', ['2', '3']), /no memories were deleted/);
    assert(await repo.readMemory('alice', '2'));
    assert.equal(await data.forget('alice', ['2']), 1);
    assert.equal(await repo.readMemory('alice', '2'), undefined);
    assert.equal(await store.readMemory('alice', '2'), undefined);
    assert.equal(
      (
        await store.pool.query(
          "SELECT count(*) FROM zero_mem0_vectors WHERE payload->>'zero_id'='2'",
        )
      ).rows[0].count,
      '0',
    );
    assert(await repo.readMemory('bob', '3'));
  } finally {
    await store.close();
    await offline.end();
    await f.close();
  }
});

test('Mem0 OSS saves and recalls with configured vectors, stable handles, profile/date/category isolation, and atomic corrections', async () => {
  const f = await fixture();
  try {
    const repo = new Mem0Repository(f.store.pool, 2, f.store);
    await repo.assertMigrated();
    await repo.insertMemory(
      'alice',
      {
        text: 'The user prefers espresso.',
        summary: 'User prefers espresso',
        category: 'Preferences',
        tags: ['coffee'],
      },
      [1, 0],
      'espresso',
      'test-space',
    );
    await repo.insertMemory(
      'bob',
      { text: 'The user prefers espresso with sugar.', category: 'Preferences', tags: ['coffee'] },
      [1, 0],
      'espresso',
      'test-space',
    );
    const semantic = await repo.searchMemory(
      'alice',
      'preferred morning beverage',
      [1, 0],
      [],
      undefined,
      undefined,
      'test-space',
    );
    assert(semantic.length > 0);
    assert(semantic.every((item) => item.text === 'The user prefers espresso.'));
    const first = semantic[0];
    assert.match(first.id, /^[1-9]\d*$/);
    assert.equal(
      (
        await repo.searchMemory(
          'alice',
          'beverage',
          [1, 0],
          ['Private'],
          undefined,
          undefined,
          'test-space',
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await repo.searchMemory(
          'alice',
          'beverage',
          [1, 0],
          [],
          '2000-01-01T00:00:00Z',
          '2001-01-01T00:00:00Z',
          'test-space',
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await repo.searchMemory(
          'alice',
          'beverage',
          [1, 0],
          [],
          undefined,
          undefined,
          'other-space',
        )
      ).length,
      0,
    );
    await assert.rejects(
      repo.insertMemory(
        'bob',
        { text: 'Invalid correction', category: 'Ideas', tags: [], supersedes: [first.id] },
        null,
      ),
      /active record in this profile/,
    );
    await repo.insertMemory(
      'alice',
      {
        text: 'The user now prefers tea.',
        category: 'Preferences',
        tags: ['tea'],
        supersedes: [first.id],
      },
      [1, 0],
      'tea',
      'test-space',
    );
    assert((await repo.readMemory('alice', first.id))!.superseded_by);
    const current = await repo.searchMemory(
      'alice',
      'beverage',
      [1, 0],
      [],
      undefined,
      undefined,
      'test-space',
    );
    assert(current.every((item) => item.text === 'The user now prefers tea.'));
    const page = await repo.memories('alice', '', undefined, 0, 1);
    assert.equal(page.total, 1);
    assert.equal(page.next_offset, null);
    await repo.forget('alice', [current[0].id]);
    assert.equal(
      (await repo.searchMemory('alice', 'beverage', [1, 0], [], undefined, undefined, 'test-space'))
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('keyword-only memory, disabled mode and sourced saves retain their existing contracts with Mem0', async () => {
  const f = await fixture();
  try {
    const repo = new Mem0Repository(f.store.pool, 2, f.store);
    const memory = new Memory(
      { ...f.config.memory, mode: 'simple', sharedProfile: 'shared' },
      repo,
      {
        enabled: true,
        async embed() {
          throw new Error('Keyword-only mode must not call the embedding provider');
        },
      },
    );
    await memory.save(
      'alice',
      {
        text: 'The assistant recommended encrypted backups.',
        category: 'Ideas',
        tags: ['backup'],
      },
      'extract:alice:source:0',
    );
    assert.equal((await memory.search('bob', 'encrypted')).length, 1);
    const result = (await memory.search('alice', 'encrypted'))[0];
    assert(result);
    await memory.read('bob', result.id);
    const disabled = new Memory({ ...f.config.memory, mode: 'none' }, repo, {
      enabled: false,
      async embed() {
        throw new Error('disabled');
      },
    });
    assert.deepEqual(await disabled.search('alice', 'encrypted'), []);
    await assert.rejects(
      disabled.save('alice', { text: 'No', category: 'Ideas', tags: [] }),
      /disabled/,
    );
  } finally {
    await f.close();
  }
});

test('uncertain pending writes are not replayed, and an offline import cannot run against an active assistant', async () => {
  const f = await fixture();
  try {
    const repo = new Mem0Repository(f.store.pool, 2, f.store);
    await f.store.pool.query(
      "INSERT INTO zero_mem0_records(session,source,status) VALUES('alice','pending-source','pending')",
    );
    await assert.rejects(
      repo.insertMemory(
        'alice',
        { text: 'Never replay', category: 'Ideas', tags: [] },
        null,
        'pending-source',
      ),
      /Uncertain Mem0 write/,
    );
    await assert.rejects(
      repo.insertMemory('alice', { text: 'No invalid vector', category: 'Ideas', tags: [] }, [1]),
      /dimensions/,
    );
    await assert.rejects(repo.readMemory('alice', '9999999999999999999'), /Invalid memory ID/);
    {
      // The store already holds the shared runtime lock on a different connection.
      const isolated = new pg.Pool({
        connectionString: f.url,
        options: `-c search_path=${f.schema},public`,
      });
      try {
        await assert.rejects(migrateMem0(isolated, true), /Stop the assistant/);
      } finally {
        await isolated.end();
      }
    }
  } finally {
    await f.close();
  }
});
