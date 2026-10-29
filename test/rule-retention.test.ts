import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresRules } from '../src/adapters/outbound/postgres-rules.js';
import { RuleRetention } from '../src/application/rule-retention.js';
import type { NotificationRule } from '../src/domain/notification-rule.js';
import { fixture, until } from './helpers.js';

const retention = 48 * 3_600_000;
function value(extra: Partial<NotificationRule> = {}) {
  return {
    session: 'telegram:1',
    kind: 'reminder' as const,
    message: 'Retention example',
    status: 'active' as const,
    next_at: '2026-10-29T12:00:00.000Z',
    repeat_seconds: null,
    remaining_seconds: null,
    condition: null,
    cooldown_seconds: 0,
    recurring: false,
    matched_since: null,
    last_checked: null,
    last_fired: null,
    latched: false,
    forecast_signature: null,
    ...extra,
  };
}
async function setup() {
  const f = await fixture();
  let now = Date.parse('2026-10-29T12:00:00Z');
  const repository = new PostgresRules(f.store.db, () => new Date(now));
  return {
    ...f,
    repository,
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('terminal rules expire at 48 hours while active, paused, and recurring rules survive', async () => {
  const f = await setup();
  try {
    const finished = await Promise.all([
      f.repository.create(value({ status: 'completed' })),
      f.repository.create(value({ kind: 'timer', status: 'expired' })),
      f.repository.create(value({ kind: 'alert', status: 'cancelled' })),
    ]);
    const retained = await Promise.all([
      f.repository.create(value()),
      f.repository.create(value({ status: 'paused' })),
      f.repository.create(
        value({ kind: 'alert', recurring: true, last_fired: f.now().toISOString() }),
      ),
    ]);
    await f.store.pool.query("UPDATE notification_rules SET created='2020-01-01'");
    f.advance(retention - 1);
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 0);
    f.advance(1);
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 3);
    for (const rule of finished) assert.equal(await f.repository.byId(rule.id), undefined);
    for (const rule of retained) assert.ok(await f.repository.byId(rule.id));
  } finally {
    await f.close();
  }
});

test('pending/running deliveries block pruning; receipts are deleted atomically without deleting jobs', async () => {
  const f = await setup();
  try {
    const rule = await f.repository.create(value());
    const event = {
      id: rule.id,
      generation: rule.generation,
      event_id: randomUUID(),
      fired_at: f.now().toISOString(),
    };
    assert.equal(await f.repository.accept(event), true);
    assert.equal((await f.repository.byId(rule.id))?.retired_at, f.now().toISOString());
    f.advance(retention);
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 0);
    const job = (await f.store.claim([]))!;
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 0);
    await f.store.finish(job.id, 'Delivered example');
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 1);
    assert.equal(await f.repository.byId(rule.id), undefined);
    assert.equal(
      (await f.store.pool.query('SELECT count(*) FROM notification_rule_events')).rows[0].count,
      '0',
    );
    assert.equal((await f.store.job(job.id))?.output, 'Delivered example');
    assert.equal(await f.repository.accept(event), false);
    assert.equal(await f.store.claim([]), undefined);
  } finally {
    await f.close();
  }
});

test('legacy finished rows receive a grace period and cleanup batches are bounded and safe to repeat', async () => {
  const f = await setup();
  try {
    const rules = await Promise.all(
      Array.from({ length: 3 }, () => f.repository.create(value({ status: 'completed' }))),
    );
    await f.store.pool.query("UPDATE notification_rules SET value=value-'retired_at'");
    assert.equal(await f.repository.pruneFinished(f.now(), 2), 2);
    assert.equal((await f.repository.list('telegram:1', undefined, 0, 10)).total, 3);
    assert.equal(await f.repository.pruneFinished(f.now(), 2), 1);
    for (const rule of rules)
      assert.equal((await f.repository.byId(rule.id))?.retired_at, f.now().toISOString());
    assert.equal(await f.repository.pruneFinished(f.now(), 2), 0);
    f.advance(retention);
    const counts = await Promise.all([
      f.repository.pruneFinished(f.now(), 2),
      f.repository.pruneFinished(f.now(), 2),
    ]);
    assert.equal(
      counts.reduce((a, b) => a + b),
      3,
    );
    assert.equal((await f.repository.list('telegram:1', undefined, 0, 10)).total, 0);
  } finally {
    await f.close();
  }
});

test('reactivation clears retirement and later completion starts a fresh retention period', async () => {
  const f = await setup();
  try {
    const rule = await f.repository.create(value({ status: 'completed' }));
    f.advance(retention - 1000);
    assert.equal(await f.repository.apply({ ...rule, status: 'active' }), true);
    const active = (await f.repository.byId(rule.id))!;
    assert.equal(active.retired_at, null);
    f.advance(2000);
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 0);
    assert.equal(await f.repository.apply({ ...active, status: 'cancelled' }), true);
    const cancelled = (await f.repository.byId(rule.id))!;
    assert.equal(cancelled.retired_at, f.now().toISOString());
    f.advance(retention - 1);
    assert.equal(await f.repository.apply({ ...cancelled, message: 'Edited finished rule' }), true);
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 0);
    f.advance(1);
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 1);
  } finally {
    await f.close();
  }
});

test('wake-up completion starts retention only for the delivered rule version', async () => {
  const f = await setup();
  try {
    const rule = await f.repository.create(value({ wake_date: '2026-10-29', next_at: null }));
    await f.repository.completeWakeReminders(rule.session, [rule]);
    assert.equal((await f.repository.byId(rule.id))?.retired_at, f.now().toISOString());
    f.advance(retention - 1);
    await f.repository.completeWakeReminders(rule.session, [rule]);
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 0);
    f.advance(1);
    assert.equal(await f.repository.pruneFinished(f.now(), 100), 1);
  } finally {
    await f.close();
  }
});

test('retention worker drains full batches without overlap and waits for in-flight cleanup on shutdown', async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new RuleRetention({
    async pruneFinished() {
      calls++;
      if (calls === 1) return 100;
      await blocked;
      return 0;
    },
  });
  worker.start();
  worker.start();
  await until(() => calls === 2);
  let closed = false;
  const closing = worker.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
  assert.equal(calls, 2);
});
