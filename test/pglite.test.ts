import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPGlite } from '../src/adapters/outbound/pglite-runtime.js';
import { Store } from '../src/adapters/outbound/postgres-store.js';
import { Mem0Repository } from '../src/adapters/outbound/mem0-repository.js';
import { PostgresServiceSettings } from '../src/adapters/outbound/postgres-service-settings.js';
import { ServiceConfigSchema } from '../src/adapters/outbound/config-schema.js';

// Real persistent engine, wire bridge, generated migrations and unmodified Mem0 SDK.
test('PGlite preserves durable state, serialized claims, rollback and scoped Mem0 vectors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero-pglite-test-'));
  const path = join(dir, 'db');
  let runtime = await openPGlite(path);
  let store: Store | undefined;
  try {
    await assert.rejects(openPGlite(path), /already in use/);
    store = await Store.open(runtime.url, 3072);
    const settings = new PostgresServiceSettings(store.db, 'test-encryption-key-long-enough');
    await settings.initialize(ServiceConfigSchema.parse({}));
    const saved = await settings.read();
    assert.equal(await settings.update(saved.revision, { ...saved.value, timezone: 'UTC' }), true);
    await store.setThread('alice', 'retained-thread', 'same-policy');
    const jobs = await Promise.all(
      Array.from({ length: 4 }, () => store!.enqueue('alice', {}, 'dedupe')),
    );
    assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
    await store.enqueue('alice', {});
    const bob = await store.enqueue('bob', {});
    const claims = await Promise.all(Array.from({ length: 6 }, () => store!.claim([])));
    assert.deepEqual(
      new Set(claims.filter(Boolean).map((job) => job!.id)),
      new Set([jobs[0].id, bob.id]),
    );
    await store.finish(jobs[0].id, 'done');
    await store.finish(bob.id, 'done');
    assert.equal((await store.claim([]))?.session, 'alice');

    // A second connection cannot observe or accidentally join an uncommitted transaction.
    const transaction = await store.pool.connect();
    await transaction.query('BEGIN');
    await transaction.query("INSERT INTO cursors(name,value) VALUES('rollback',99)");
    const concurrent = store.cursor('rollback');
    await transaction.query('ROLLBACK');
    transaction.release();
    assert.equal(await concurrent, 0);
    const abandoned = await store.pool.connect();
    await abandoned.query('BEGIN');
    await abandoned.query("INSERT INTO cursors(name,value) VALUES('abandoned',99)");
    abandoned.release(true);
    assert.equal(await store.cursor('abandoned'), 0);

    const vector = Array.from({ length: 3072 }, (_, index) => (index === 0 ? 1 : 0));
    const repo = new Mem0Repository(store.pool, 3072, store);
    await repo.insertMemory(
      'alice',
      { text: 'Alice prefers coffee', category: 'Preferences', tags: ['coffee'] },
      vector,
      'one',
      'test-space',
    );
    await repo.insertMemory(
      'bob',
      { text: 'Private coffee preference', category: 'Private', tags: [] },
      vector,
      'two',
      'test-space',
    );
    const found = await repo.searchMemory(
      'alice',
      'coffee',
      vector,
      [],
      undefined,
      undefined,
      'test-space',
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].text, 'Alice prefers coffee');
    assert.equal(await repo.readMemory('bob', found[0].id), undefined);
    assert.deepEqual(await repo.memoryCatalog('alice'), {
      categories: ['Preferences'],
      tags: ['coffee'],
    });
    const id = found[0].id;
    await store.close();
    store = undefined;
    await runtime.close();
    runtime = await openPGlite(path);
    store = await Store.open(runtime.url, 3072);
    assert.equal(await store.thread('alice'), 'retained-thread');
    assert.equal(await store.threadPolicy('alice'), 'same-policy');
    assert.equal((await store.job(jobs[0].id))?.output, 'done');
    assert.equal(
      (await new PostgresServiceSettings(store.db, 'test-encryption-key-long-enough').read()).value
        .timezone,
      'UTC',
    );
    const reopened = new Mem0Repository(store.pool, 3072, store);
    assert.equal((await reopened.readMemory('alice', id))?.text, 'Alice prefers coffee');
    assert.equal(
      (
        await reopened.searchMemory(
          'alice',
          'coffee',
          vector,
          ['Preferences'],
          undefined,
          undefined,
          'test-space',
        )
      ).length,
      1,
    );
    assert.equal(await reopened.forget('alice', [id]), 1);
    assert.equal(await reopened.readMemory('alice', id), undefined);
    assert.equal(
      (
        await reopened.searchMemory(
          'alice',
          'coffee',
          vector,
          [],
          undefined,
          undefined,
          'test-space',
        )
      ).length,
      0,
    );
  } finally {
    await store?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
