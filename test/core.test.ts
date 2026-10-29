import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/adapters/outbound/postgres-store.js';
import { Memory } from '../src/application/memory.js';
import { Scheduler } from '../src/application/scheduler.js';
import { dayRange } from '../src/domain/time.js';
import { fixture } from './helpers.js';
test('durable jobs deduplicate, serialize sessions and never replay interrupted actions', async () => {
  const f = await fixture();
  const a = await f.store.enqueue('one', { text: 'first' }, 'update1');
  assert.equal((await f.store.enqueue('one', { text: 'duplicate' }, 'update1')).id, a.id);
  await f.store.enqueue('one', { text: 'second' });
  const b = await f.store.enqueue('two', { text: 'parallel' });
  assert.equal((await f.store.claim([]))?.id, a.id);
  assert.equal((await f.store.claim(['one']))?.id, b.id);
  await f.store.close();
  const reopened = await Store.open(f.url, 2, f.schema);
  assert.equal((await reopened.job(a.id))?.status, 'failed');
  assert.match((await reopened.job(a.id))?.error || '', /inspect effects/);
  await reopened.close();
  await f.close();
});
test('reset hides short-term context while retaining long-term memory', async () => {
  const f = await fixture();
  try {
    await f.store.addMessage('one', 'user', 'old context');
    await f.store.setThread('one', 'thread1');
    await f.store.insertMemory(
      'one',
      { text: 'persistent fact', category: 'Ideas', tags: [] },
      null,
    );
    await f.store.reset('one');
    assert.equal(await f.store.thread('one'), null);
    assert.deepEqual(await f.store.history('one'), []);
    await f.store.addMessage('one', 'user', 'new context');
    assert.equal((await f.store.history('one')).length, 1);
    assert.equal(
      Number(
        (await f.store.pool.query("SELECT count(*) FROM memories WHERE session='one'")).rows[0]
          .count,
      ),
      1,
    );
  } finally {
    await f.close();
  }
});
test('memory is session-isolated, semantically ranked, date filtered and sourced saves are idempotent', async () => {
  const f = await fixture();
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
    assert.equal(found[0].summary, 'trade idea');
    assert.equal((await memory.search('one', 'trade', [], '2100-01-01')).length, 0);
    const fragment = { text: 'trade fragment', category: 'Trading', tags: [] };
    await memory.save('one', fragment, 'extract:one:source:0');
    await memory.save('one', fragment, 'extract:one:source:0');
    assert.equal(
      Number(
        (await f.store.pool.query("SELECT count(*) FROM memories WHERE session='one'")).rows[0]
          .count,
      ),
      2,
    );
  } finally {
    await f.close();
  }
});
test('daily date ranges respect Madrid DST and schedules enqueue once', async () => {
  const spring = dayRange(new Date('2026-03-29T12:00:00Z'), 'Europe/Madrid');
  const autumn = dayRange(new Date('2026-10-25T12:00:00Z'), 'Europe/Madrid');
  assert.equal(Date.parse(spring.end) - Date.parse(spring.start), 23 * 3600000);
  assert.equal(Date.parse(autumn.end) - Date.parse(autumn.start), 25 * 3600000);
  const f = await fixture();
  try {
    const memory = new Memory(f.config.memory, f.store, {
      enabled: false,
      async embed() {
        return [];
      },
    });
    const notifications = {
      eventReminders: false,
      reset: { enabled: false, time: '04:00' },
      morning: { mode: 'off' as 'off' | 'time', time: '08:30', entity: '', state: 'off' },
    };
    const scheduler = new Scheduler(
      f.store,
      async () => ({ enabled: true, calendar: false, timezone: f.config.timezone, notifications }),
      async () => ['telegram:123'],
    );
    await scheduler.tick(new Date('2026-10-15T06:30:00Z'));
    assert.equal(await f.store.claim([]), undefined);
    notifications.morning.mode = 'time';
    await scheduler.tick(new Date('2026-10-15T06:30:00Z'));
    await scheduler.tick(new Date('2026-10-15T06:30:15Z'));
    const job = await f.store.claim([]);
    assert.equal(job?.payload.kind, 'morning');
    assert.equal(await f.store.claim([]), undefined);
    await f.store.finish(job!.id, 'sent');
    notifications.morning.mode = 'off';
    await scheduler.tick(new Date('2026-10-16T06:30:00Z'));
    assert.equal(await f.store.claim([]), undefined);
  } finally {
    await f.close();
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
