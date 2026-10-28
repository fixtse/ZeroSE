import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  LocalDeadlineWorker,
  LocalRuleScheduler,
  selectRuleScheduler,
} from '../src/application/local-rule-scheduler.js';
import {
  NotificationRules,
  type RuleSchedulerPort,
} from '../src/application/notification-rules.js';
import { localSchedulerIdentity } from '../src/domain/local-deadline.js';
import type { NotificationRule } from '../src/domain/notification-rule.js';
import { PostgresRules } from '../src/adapters/outbound/postgres-rules.js';
import { registerNotificationTools } from '../src/adapters/inbound/notification-tools.js';
import { Tools } from '../src/application/tool-registry.js';
import { fixture, until } from './helpers.js';

function value(
  at: number,
  extra: Partial<NotificationRule> = {},
): Omit<NotificationRule, 'id' | 'version' | 'generation'> {
  return {
    session: 'telegram:1',
    kind: 'timer',
    message: 'Local reminder',
    status: 'active',
    next_at: new Date(at).toISOString(),
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
async function setup(startedAt = Date.now() - 10_000) {
  const f = await fixture();
  const repository = new PostgresRules(f.store.db);
  await repository.initialize();
  const scheduler = new LocalRuleScheduler(repository);
  let enabled = true;
  const rules = new NotificationRules(repository, async (_session, kind, key) => ({
    enabled,
    scheduler: selectRuleScheduler(kind, key, scheduler),
  }));
  const worker = (start = startedAt, repo = repository) =>
    new LocalDeadlineWorker(
      repo,
      (event) => rules.receive(event, true),
      (rule) => rules.canNotify(rule),
      randomUUID,
      () => new Date(start),
    );
  const count = async (table = 'jobs') =>
    Number((await f.store.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  return {
    ...f,
    repository,
    scheduler,
    rules,
    worker,
    count,
    revoke: () => {
      enabled = false;
    },
  };
}

test('unchanged reminder tools create and deliver durably with no HA connection; competing ticks enqueue once', async () => {
  const f = await setup();
  try {
    assert.equal(f.config.homeAssistant.token, '');
    const tools = new Tools(f.store);
    registerNotificationTools(tools, f.rules);
    const context = {
      session: 'telegram:1',
      jobId: 'local-tools',
      signal: new AbortController().signal,
    };
    const receipt = (await tools.call(
      'timer_start',
      { message: 'Tea', duration_seconds: 1 },
      context,
    )) as { id: string };
    const rule = (await f.repository.read(context.session, receipt.id))!;
    assert.equal(rule.scheduler_key, localSchedulerIdentity);
    assert.equal(rule.scheduler_state, 'installed');
    assert.equal(
      await f.rules.receive({
        id: rule.id,
        generation: rule.generation,
        event_id: randomUUID(),
        fired_at: rule.next_at!,
      }),
      false,
    );
    const tick = new Date(Date.parse(rule.next_at!) + 1);
    await Promise.all([f.worker().tick(tick), f.worker().tick(tick)]);
    assert.equal(await f.count(), 1);
    assert.equal(await f.count('notification_rule_events'), 1);
    const [job] = (await f.store.pool.query('SELECT * FROM jobs')).rows;
    assert.equal(job.payload.ruleId, rule.id);
    assert.equal(job.session, context.session);
    assert.equal((await f.rules.notification(job)).output, '⏲️ Temporizador: Tea');
    assert.equal((await f.repository.read(context.session, rule.id))?.status, 'completed');
    assert.equal((await f.rules.inspect(context.session, rule.id)).home_assistant, undefined);
  } finally {
    await f.close();
  }
});

test('pause, resume, snooze, cancellation and revoked permissions suppress old local occurrences', async () => {
  const f = await setup();
  try {
    const now = Date.now();
    const rule = await f.rules.create(value(now + 1000));
    await f.rules.change(rule.session, rule.id, 'pause', undefined, new Date(now));
    await f.worker().tick(new Date(now + 2000));
    assert.equal(await f.count(), 0);
    await f.rules.change(rule.session, rule.id, 'resume', undefined, new Date(now));
    await f.rules.change(rule.session, rule.id, 'snooze', 10, new Date(now));
    await f.worker().tick(new Date(now + 2000));
    assert.equal(await f.count(), 0);
    await f.worker().tick(new Date(now + 10_001));
    assert.equal(await f.count(), 1);
    const [job] = (await f.store.pool.query('SELECT * FROM jobs')).rows;
    await f.rules.change(rule.session, rule.id, 'cancel');
    assert.equal((await f.rules.notification(job)).deliver, false);
    const revoked = await f.rules.create(value(now + 2000));
    f.revoke();
    await f.worker().tick(new Date(now + 3000));
    assert.equal(await f.count(), 1);
    assert.equal((await f.repository.read(revoked.session, revoked.id))?.status, 'expired');
  } finally {
    await f.close();
  }
});

test('restart retains future schedules but expires missed one-shots and skips missed repeats without replay', async () => {
  const now = Date.now();
  const f = await setup(now - 200_000);
  try {
    const missed = await f.rules.create(value(now - 1000));
    const repeating = await f.rules.create(
      value(now - 150_000, { kind: 'reminder', repeat_seconds: 60 }),
    );
    const future = await f.rules.create(value(now + 2000));
    const reopened = new PostgresRules(f.store.db);
    await reopened.initialize();
    const restarted = f.worker(now, reopened);
    await restarted.tick(new Date(now));
    assert.equal(await f.count(), 0);
    assert.equal((await reopened.read(missed.session, missed.id))?.status, 'expired');
    assert.equal(
      (await reopened.read(repeating.session, repeating.id))?.next_at,
      new Date(now + 30_000).toISOString(),
    );
    await restarted.tick(new Date(now + 2001));
    assert.equal(await f.count(), 1);
    assert.equal((await reopened.read(future.session, future.id))?.status, 'completed');
    const interrupted = await reopened.create(
      value(now + 1000, { scheduler_key: localSchedulerIdentity, scheduler_state: 'installing' }),
    );
    await reopened.initialize();
    await restarted.tick(new Date(now + 2001));
    assert.equal(
      (await reopened.read(interrupted.session, interrupted.id))?.scheduler_state,
      'uncertain',
    );
    assert.equal(await f.count(), 1);
  } finally {
    await f.close();
  }
});

test('a cancellation racing a due read invalidates the occurrence before enqueue', async () => {
  const f = await setup();
  try {
    const rule = await f.rules.create(value(Date.now() - 100));
    const worker = new LocalDeadlineWorker(
      f.repository,
      (event) => f.rules.receive(event, true),
      async () => {
        await f.rules.change(rule.session, rule.id, 'cancel');
        return true;
      },
      randomUUID,
      () => new Date(Date.now() - 10_000),
    );
    await worker.tick(new Date());
    assert.equal(await f.count(), 0);
    assert.equal((await f.repository.read(rule.session, rule.id))?.status, 'cancelled');
  } finally {
    await f.close();
  }
});

test('late recurring ticks emit only the latest valid occurrence and keep the original interval anchor', async () => {
  const now = Date.now();
  const f = await setup(now - 200_000);
  try {
    const rule = await f.rules.create(
      value(now - 150_000, { kind: 'reminder', repeat_seconds: 60 }),
    );
    await f.worker().tick(new Date(now));
    await f.worker().tick(new Date(now));
    assert.equal(await f.count(), 1);
    assert.equal(
      (await f.repository.read(rule.session, rule.id))?.next_at,
      new Date(now + 30_000).toISOString(),
    );
  } finally {
    await f.close();
  }
});

test('deadline advancement and enqueue roll back together if the queue insert fails', async () => {
  const f = await setup();
  try {
    const rule = await f.rules.create(value(Date.now() - 100));
    await f.store.pool
      .query(`CREATE FUNCTION reject_local_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only queue failure'; END $$;
      CREATE TRIGGER reject_local_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_local_job()`);
    await assert.rejects(f.worker().tick(new Date()), /queue failure|Failed query/);
    assert.equal((await f.repository.read(rule.session, rule.id))?.status, 'active');
    assert.equal(await f.count('notification_rule_events'), 0);
    await f.store.pool.query('DROP TRIGGER reject_local_job ON jobs');
    await f.worker().tick(new Date());
    assert.equal(await f.count(), 1);
  } finally {
    await f.close();
  }
});

test('routing keeps HA rules and additional conditions on HA without migrating unavailable backends', () => {
  const local = { identity: localSchedulerIdentity } as RuleSchedulerPort;
  const ha = { identity: 'ha-connection' } as RuleSchedulerPort;
  assert.equal(selectRuleScheduler('timer', undefined, local), local);
  assert.equal(selectRuleScheduler('reminder', 'ha-connection', local, ha), ha);
  assert.equal(selectRuleScheduler('reminder', 'legacy-home-assistant', local, ha), ha);
  assert.equal(selectRuleScheduler('alert', undefined, local, ha), ha);
  assert.equal(selectRuleScheduler('alert', undefined, local), undefined);
  assert.equal(selectRuleScheduler('reminder', 'retired-backend', local, ha), undefined);
});

test('worker shutdown waits for an in-flight tick and prevents further scheduling', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const worker = new LocalDeadlineWorker(
    {
      byId: async () => undefined,
      apply: async () => true,
      dueLocal: async () => {
        entered = true;
        await gate;
        return [];
      },
    },
    async () => true,
    async () => true,
    randomUUID,
  );
  worker.start();
  await until(() => entered);
  let closed = false;
  const closing = worker.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
});
