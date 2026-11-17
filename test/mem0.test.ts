import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/application/memory.js';
import { Mem0Repository, withMem0PersonalData } from '../src/adapters/outbound/mem0-repository.js';
import { PostgresPersonalData } from '../src/adapters/outbound/postgres-personal-data.js';
import { fixture } from './helpers.js';

test('Mem0 OSS saves and recalls with configured vectors, stable handles, profile/date/category isolation, and atomic corrections', async () => {
  const f = await fixture();
  try {
    const repo = new Mem0Repository(f.store.pool, 2, f.store);
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

test('uncertain pending writes are not replayed', async () => {
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
  } finally {
    await f.close();
  }
});
