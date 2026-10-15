import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/adapters/outbound/sqlite-store.js';
import { Memory } from '../src/application/memory.js';
import { Scheduler } from '../src/application/scheduler.js';
import { dayRange } from '../src/domain/time.js';
import { fixture } from './helpers.js';

test('durable jobs deduplicate, serialize sessions and never replay interrupted actions', () => {
  const f = fixture();
  const a = f.store.enqueue('one', { text: 'first' }, 'update1');
  assert.equal(f.store.enqueue('one', { text: 'duplicate' }, 'update1').id, a.id);
  f.store.enqueue('one', { text: 'second' });
  const b = f.store.enqueue('two', { text: 'parallel' });
  assert.equal(f.store.claim([])?.id, a.id);
  assert.equal(f.store.claim(['one'])?.id, b.id);
  f.store.close();
  const reopened = new Store(f.dir);
  assert.equal(reopened.job(a.id)?.status, 'failed');
  assert.match(reopened.job(a.id)?.error || '', /inspect effects/);
  reopened.close();
});
test('reset hides short-term context while retaining long-term memory', () => {
  const f = fixture();
  try {
    f.store.addMessage('one', 'user', 'old context');
    f.store.setThread('one', 'thread1');
    f.store.insertMemory('one', { text: 'persistent fact', category: 'Ideas', tags: [] }, null);
    f.store.reset('one');
    assert.equal(f.store.thread('one'), null);
    assert.deepEqual(f.store.history('one'), []);
    f.store.addMessage('one', 'user', 'new context');
    assert.equal(f.store.history('one').length, 1);
    assert.equal(f.store.memories('one').length, 1);
  } finally {
    f.close();
  }
});
test('memory is session-isolated, semantically ranked, date filtered and consolidation is idempotent', async () => {
  const f = fixture();
  try {
    const embeddings = {
      enabled: true,
      async embed(value: string) {
        return value.includes('trade') ? [1, 0] : [0, 1];
      },
    };
    const memory = new Memory(f.config.memory, f.store, embeddings);
    await memory.save('one', { text: 'trade idea', category: 'Trading', tags: ['idea'] });
    await memory.save('two', { text: 'trade secret', category: 'Trading', tags: [] });
    const found = await memory.search('one', 'trade', ['Trading']);
    assert.equal(found.length, 1);
    assert.equal(found[0].text, 'trade idea');
    assert.equal((await memory.search('one', 'trade', [], '2100-01-01')).length, 0);
    f.store.addMessage('one', 'user', 'trade idea');
    const pending = memory.pending('one');
    const fragments = [{ text: 'trade fragment', category: 'Trading', tags: [] }];
    await memory.consolidate(
      'one',
      fragments,
      pending.map((m) => m.id),
    );
    await memory.consolidate(
      'one',
      fragments,
      pending.map((m) => m.id),
    );
    assert.equal(f.store.memories('one').length, 2);
    assert.equal(memory.pending('one').length, 0);
  } finally {
    f.close();
  }
});
test('daily date ranges respect Madrid DST and schedules enqueue once', () => {
  const spring = dayRange(new Date('2026-03-29T12:00:00Z'), 'Europe/Madrid');
  const autumn = dayRange(new Date('2026-10-25T12:00:00Z'), 'Europe/Madrid');
  assert.equal(Date.parse(spring.end) - Date.parse(spring.start), 23 * 3600_000);
  assert.equal(Date.parse(autumn.end) - Date.parse(autumn.start), 25 * 3600_000);
  const f = fixture();
  try {
    f.config.telegram.notificationChatId = '123';
    const memory = new Memory(f.config.memory, f.store, {
      enabled: false,
      async embed() {
        return [];
      },
    });
    const scheduler = new Scheduler(f.config, f.store, memory);
    scheduler.tick(new Date('2026-10-15T06:30:00Z'));
    assert.equal(f.store.claim([]), undefined);
    f.config.schedules.enabled = true;
    scheduler.tick(new Date('2026-10-15T06:30:00Z'));
    scheduler.tick(new Date('2026-10-15T06:30:15Z'));
    const job = f.store.claim([]);
    assert.equal(job?.payload.kind, 'morning');
    assert.equal(f.store.claim([]), undefined);
  } finally {
    f.close();
  }
});
test('hexagonal boundaries keep domain and application independent of adapters', () => {
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
      item.isDirectory() ? files(join(dir, item.name)) : [join(dir, item.name)],
    );
  }
  for (const file of files(resolve('src/domain')))
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /from ['"].*(application|adapters|node:|pg|zod)/,
    );
  for (const file of files(resolve('src/application')))
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /from ['"].*(adapters|node:fs|node:sqlite|node:child_process|['"]pg['"])/,
    );
});
