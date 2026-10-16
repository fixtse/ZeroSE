import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { PostgresPersonalData } from '../src/adapters/outbound/postgres-personal-data.js';
import { Memory } from '../src/application/memory.js';
import { Tools } from '../src/application/tool-registry.js';
import { registerPersonalDataTools } from '../src/adapters/inbound/personal-data-tools.js';

test('forget erases saved text/embedding, stays profile-scoped, and does not resurrect through reads/catalog/search', async () => {
  const f = await fixture();
  try {
    const data = new PostgresPersonalData(f.store.pool);
    const memory = new Memory({ ...f.config.memory, mode: 'simple' }, f.store, {
      enabled: false,
      async embed() {
        throw new Error('Unexpected embedding');
      },
    });
    await memory.save('one', {
      text: 'Old address Madrid',
      category: 'Addresses',
      tags: ['private'],
    });
    await memory.save('two', { text: 'Other address London', category: 'Addresses', tags: [] });
    const first = (await data.memories('one', 'Madrid', undefined, 0, 10)).items[0] as any;
    const second = (await data.memories('two', '', undefined, 0, 10)).items[0] as any;
    await assert.rejects(data.forget('one', [first.id, second.id]), /Every memory/);
    assert.equal((await memory.search('one', 'Madrid')).length, 1);
    assert.equal(await data.forget('one', [first.id]), 1);
    assert.equal((await memory.search('one', 'Madrid')).length, 0);
    await assert.rejects(memory.read('one', first.id), /not found/);
    assert.deepEqual(await f.store.memoryCatalog('one'), { categories: [], tags: [] });
    const row = (
      await f.store.pool.query('SELECT text,embedding FROM memories WHERE id=$1', [first.id])
    ).rows[0];
    assert.equal(row.text, '');
    assert.equal(row.embedding, null);
    assert.equal((await memory.search('two', 'London')).length, 1);
  } finally {
    await f.close();
  }
});
test('conversation search spans resets but never other chats, and disabled memory keeps only history tools', async () => {
  const f = await fixture();
  try {
    const data = new PostgresPersonalData(f.store.pool);
    await f.store.addMessage('one', 'assistant', 'Recommended a beach holiday');
    await f.store.reset('one');
    await f.store.addMessage('one', 'user', 'Booked a beach holiday');
    await f.store.addMessage('two', 'user', 'Secret beach holiday');
    const found = await data.conversations('one', 'beach', undefined, undefined, 0, 1);
    assert.equal(found.total, 2);
    assert.equal(found.next_offset, 1);
    const id = (found.items[0] as any).id;
    assert.equal(((await data.message('one', id)) as any).role, 'user');
    await assert.rejects(data.message('two', id), /not found/);
    const tools = new Tools(f.store);
    registerPersonalDataTools(tools, data, false);
    assert.deepEqual(
      tools.definitions().map((d) => d.name),
      ['conversation_search', 'conversation_read'],
    );
    assert.equal(
      (await data.conversations('one', 'beach', '2099-01-01T00:00:00Z', undefined, 0, 10)).total,
      0,
    );
  } finally {
    await f.close();
  }
});
