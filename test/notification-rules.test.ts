import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { evaluateRule, type NotificationRule } from '../src/domain/notification-rule.js';
import { NotificationRules, forecastObservation } from '../src/application/notification-rules.js';
import { PostgresRules } from '../src/adapters/outbound/postgres-rules.js';
import { registerNotificationTools } from '../src/adapters/inbound/notification-tools.js';
import { Tools } from '../src/application/tool-registry.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { rulesToken } from '../src/application/rules-auth.js';
import { fixture, until } from './helpers.js';

const now = new Date('2026-10-16T12:00:00Z');
function rule(extra: Partial<NotificationRule> = {}): NotificationRule {
  return {
    id: 'a',
    session: 'telegram:1',
    kind: 'timer',
    message: 'Check oven',
    status: 'active',
    next_at: now.toISOString(),
    repeat_seconds: null,
    remaining_seconds: null,
    condition: null,
    cooldown_seconds: 60,
    recurring: false,
    matched_since: null,
    last_checked: null,
    last_fired: null,
    latched: false,
    forecast_signature: null,
    version: 0,
    generation: 0,
    ...extra,
  };
}
test('timers fire once, expire missed deadlines, and recurring reminders skip missed intervals', () => {
  const first = evaluateRule(rule(), now);
  assert.equal(first.fire, true);
  assert.equal(first.rule.status, 'completed');
  assert.equal(evaluateRule(first.rule, now).fire, false);
  const late = new Date(now.getTime() + 120000);
  assert.equal(evaluateRule(rule(), late).rule.status, 'expired');
  const repeated = evaluateRule(rule({ repeat_seconds: 60 }), late);
  assert.equal(repeated.fire, false);
  assert.equal(repeated.rule.next_at, '2026-10-16T12:03:00.000Z');
});
test('sensor alerts require continuous valid readings, rearm after false, and observe cooldown', () => {
  let r = rule({
    kind: 'alert',
    next_at: null,
    recurring: true,
    condition: { entity_id: 'sensor.freezer', operator: 'above', value: -10, hold_seconds: 20 },
  });
  const step = (seconds: number, value: string) => {
    const result = evaluateRule(r, new Date(now.getTime() + seconds * 1000), value);
    r = result.rule;
    return result.fire;
  };
  assert.equal(step(0, '-5'), false);
  assert.equal(step(10, 'unavailable'), false);
  assert.equal(step(20, '-5'), false);
  assert.equal(step(30, '-5'), false);
  assert.equal(step(40, '-5'), true);
  assert.equal(step(50, '-5'), false);
  assert.equal(step(60, '-15'), false);
  assert.equal(step(70, '-5'), false);
  assert.equal(step(80, '-5'), false);
  assert.equal(step(90, '-5'), false);
  assert.equal(step(100, '-5'), true);
  assert.equal(step(200, 'unknown'), false);
  assert.equal(step(210, '-5'), false); // unavailable never rearms a latched alert
});
test('forecast alerts baseline once and fire only on changed forecasts containing rain', () => {
  const condition = { source: 'weather' as const, horizon_hours: 24, minimum_probability: 30 };
  let r = rule({ kind: 'alert', condition, next_at: null, recurring: true });
  const forecast = (weather: string, probability: number) =>
    forecastObservation(
      {
        service_response: {
          'weather.home': {
            forecast: [
              {
                datetime: '2026-10-16T14:00:00Z',
                condition: weather,
                precipitation_probability: probability,
              },
            ],
          },
        },
      },
      24,
      30,
      now,
    )!;
  const sunny = forecast('sunny', 0),
    rainy = forecast('rainy', 70);
  assert.equal(sunny.rain, false);
  let result = evaluateRule(r, now, undefined, sunny);
  assert.equal(result.fire, false);
  r = result.rule;
  result = evaluateRule(r, now, undefined, rainy);
  assert.equal(result.fire, true);
  assert.equal(
    evaluateRule(result.rule, new Date(now.getTime() + 120000), undefined, rainy).fire,
    false,
  );
  assert.equal(forecastObservation({}, 24, 30, now), undefined);
});
test('notification state and queue insertion are atomic; cancellation suppresses queued delivery', async () => {
  const f = await fixture();
  try {
    const repository = new PostgresRules(f.store.pool);
    await repository.initialize();
    const rules = new NotificationRules(repository, async () => ({ enabled: true }));
    const { id: _id, version: _version, generation: _generation, ...input } = rule();
    const saved = await repository.create(input);
    const evaluated = evaluateRule(saved, now);
    assert.deepEqual(
      (
        await Promise.all([
          repository.apply(evaluated.rule, true),
          repository.apply(evaluated.rule, true),
        ])
      ).sort(),
      [false, true],
    );
    const job = await f.store.claim([]);
    assert.equal(job?.payload.kind, 'rule_notification');
    assert.match((await rules.notification(job!)).output, /Check oven/);
    assert.equal(await repository.read('telegram:2', saved.id), undefined);
    await assert.rejects(rules.change('telegram:2', saved.id, 'cancel'), /not found/);
    await rules.change('telegram:1', saved.id, 'cancel');
    assert.equal((await rules.notification(job!)).deliver, false);
  } finally {
    await f.close();
  }
});
test('tools reject unhealthy scheduler and HTTP recipients; pause/resume and snooze invalidate old notifications', async () => {
  const f = await fixture();
  try {
    const repository = new PostgresRules(f.store.pool);
    await repository.initialize();
    const rules = new NotificationRules(repository, async () => ({ enabled: true }));
    const tools = new Tools(f.store);
    registerNotificationTools(tools, rules);
    const context = { session: 'telegram:1', jobId: 'test', signal: AbortSignal.timeout(10000) };
    await assert.rejects(
      tools.call('timer_start', { message: 'Tea', duration_seconds: 60 }, context),
      /heartbeat/,
    );
    await repository.heartbeat(new Date());
    await assert.rejects(
      tools.call(
        'timer_start',
        { message: 'Tea', duration_seconds: 60 },
        { ...context, session: 'api:one' },
      ),
      /Telegram/,
    );
    const created = (await tools.call(
      'timer_start',
      { message: 'Tea', duration_seconds: 60 },
      context,
    )) as any;
    await rules.change(context.session, created.id, 'pause');
    const paused = await repository.read(context.session, created.id);
    assert.equal(paused?.status, 'paused');
    assert.ok(paused!.remaining_seconds! > 50);
    await rules.change(context.session, created.id, 'resume');
    await rules.change(context.session, created.id, 'snooze', 120);
    assert.equal((await repository.read(context.session, created.id))?.generation, 3);
    await rules.change(context.session, created.id, 'cancel');
    await assert.rejects(rules.change(context.session, created.id, 'resume'), /does not apply/);
  } finally {
    await f.close();
  }
});
test('HA heartbeat uses a scoped bearer, rejects the admin bearer, and does not grant chat API access', async () => {
  const f = await fixture();
  let ticks = 0;
  const server = createHttpServer(f.config, f.store, undefined, undefined, undefined, {
    async tick() {
      ticks++;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const heartbeat = { Authorization: `Bearer ${rulesToken(f.config.apiKey)}` };
  try {
    assert.equal(
      (
        await fetch(base + '/v1/triggers/rules', {
          method: 'POST',
          headers: { Authorization: `Bearer ${f.config.apiKey}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(base + '/v1/triggers/rules', { method: 'POST', headers: heartbeat })).status,
      202,
    );
    await until(() => ticks === 1);
    assert.equal(
      (await fetch(base + '/v1/chat', { method: 'POST', headers: heartbeat })).status,
      401,
    );
  } finally {
    server.close();
    await once(server, 'close');
    await f.close();
  }
});

test('overlapping heartbeats enqueue once; revoked HA access pauses only alerts', async () => {
  const f = await fixture();
  try {
    const repository = new PostgresRules(f.store.pool);
    await repository.initialize();
    const {
      id: _id,
      version: _version,
      generation: _generation,
      ...input
    } = rule({ next_at: new Date().toISOString() });
    const timer = await repository.create(input);
    const alert = await repository.create({
      ...input,
      kind: 'alert',
      next_at: null,
      condition: { entity_id: 'sensor.test', operator: 'above', value: 10, hold_seconds: 0 },
    });
    const rules = new NotificationRules(repository, async () => ({ enabled: true }));
    await Promise.all([rules.tick(), rules.tick(), rules.tick()]);
    assert.equal((await repository.read(input.session, timer.id))?.status, 'completed');
    assert.equal((await repository.read(input.session, alert.id))?.status, 'paused');
    assert.equal((await f.store.pool.query('SELECT count(*) FROM jobs')).rows[0].count, '1');
    assert.equal(await repository.healthy(new Date()), true);
    assert.equal((await repository.list(input.session, undefined, 0, 20)).total, 1);
    assert.equal((await repository.list(input.session, 'alert', 0, 20)).total, 1);
    await rules.close();
    await rules.tick();
  } finally {
    await f.close();
  }
});

test('forecast baseline observes all forecast fields, not just precipitation', () => {
  const observation = (temperature: number) =>
    forecastObservation(
      {
        service_response: {
          'weather.home': {
            forecast: [
              {
                datetime: now.toISOString(),
                condition: 'rainy',
                precipitation_probability: 70,
                temperature,
              },
            ],
          },
        },
      },
      24,
      30,
      now,
    )!;
  const before = observation(20),
    after = observation(15);
  assert.notEqual(before.signature, after.signature);
  const r = rule({
    kind: 'alert',
    next_at: null,
    condition: { source: 'weather', horizon_hours: 24, minimum_probability: 30 },
    forecast_signature: before.signature,
    recurring: true,
  });
  assert.equal(evaluateRule(r, now, undefined, after).fire, true);
});
