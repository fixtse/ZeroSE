import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  NotificationRules,
  type RuleSchedulerPort,
} from '../src/application/notification-rules.js';
import { PostgresRules } from '../src/adapters/outbound/postgres-rules.js';
import { HomeAssistantRuleScheduler } from '../src/adapters/outbound/ha-rule-scheduler.js';
import type { NotificationRule } from '../src/domain/notification-rule.js';
import { registerNotificationTools } from '../src/adapters/inbound/notification-tools.js';
import { Tools } from '../src/application/tool-registry.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { rulesToken } from '../src/application/rules-auth.js';
import { fixture } from './helpers.js';

function value(
  extra: Partial<NotificationRule> = {},
): Omit<NotificationRule, 'id' | 'version' | 'generation'> {
  return {
    session: 'telegram:1',
    kind: 'timer',
    message: 'Check oven',
    status: 'active',
    next_at: new Date(Date.now() + 60000).toISOString(),
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
    ...extra,
  };
}
function fakeScheduler() {
  const configurations: NotificationRule[] = [];
  const scheduler: RuleSchedulerPort = {
    async ready() {},
    async configure(rule) {
      configurations.push(structuredClone(rule));
    },
    async inspect(id) {
      const rule = configurations.findLast((r) => r.id === id)!;
      return { generation: rule.generation, status: rule.status, next_at: rule.next_at };
    },
  };
  return { scheduler, configurations };
}
async function setup() {
  const f = await fixture();
  const repository = new PostgresRules(f.store.pool);
  await repository.initialize();
  const fake = fakeScheduler();
  let permitted = true;
  const rules = new NotificationRules(repository, async () => ({
    enabled: permitted,
    scheduler: fake.scheduler,
  }));
  return {
    ...f,
    repository,
    rules,
    ...fake,
    revoke() {
      permitted = false;
    },
  };
}

test('matched HA events are deduplicated atomically and queued in the owning chat', async () => {
  const f = await setup();
  try {
    const rule = await f.rules.create(value({ next_at: new Date().toISOString() }));
    assert.equal(f.configurations.length, 1);
    const event = {
      id: rule.id,
      generation: 0,
      event_id: randomUUID(),
      fired_at: new Date().toISOString(),
    };
    assert.deepEqual((await Promise.all([f.rules.receive(event), f.rules.receive(event)])).sort(), [
      false,
      true,
    ]);
    const job = await f.store.claim([]);
    assert.equal(job?.session, 'telegram:1');
    assert.equal(job?.payload.kind, 'rule_notification');
    assert.match((await f.rules.notification(job!)).output, /Check oven/);
    assert.equal((await f.repository.read('telegram:1', rule.id))?.status, 'completed');
    assert.equal(await f.repository.read('telegram:2', rule.id), undefined);
    await f.rules.change('telegram:1', rule.id, 'cancel');
    assert.equal((await f.rules.notification(job!)).deliver, false);
    assert.equal(f.configurations.at(-1)?.status, 'cancelled');
  } finally {
    await f.close();
  }
});

test('pause/resume and snooze invalidate old generations; revoked access rejects callbacks', async () => {
  const f = await setup();
  try {
    const rule = await f.rules.create(value());
    await assert.rejects(f.rules.change('telegram:2', rule.id, 'cancel'), /not found/);
    await f.rules.change('telegram:1', rule.id, 'pause');
    assert.ok((await f.repository.read('telegram:1', rule.id))!.remaining_seconds! > 50);
    await f.rules.change('telegram:1', rule.id, 'resume');
    await f.rules.change('telegram:1', rule.id, 'snooze', 120);
    assert.equal(f.configurations.at(-1)?.generation, 3);
    assert.equal(
      await f.rules.receive({
        id: rule.id,
        generation: 0,
        event_id: randomUUID(),
        fired_at: new Date().toISOString(),
      }),
      false,
    );
    f.revoke();
    assert.equal(
      await f.rules.receive({
        id: rule.id,
        generation: 3,
        event_id: randomUUID(),
        fired_at: new Date().toISOString(),
      }),
      false,
    );
    await f.rules.change('telegram:1', rule.id, 'cancel');
  } finally {
    await f.close();
  }
});

test('uncertain remote setup is visible by ID and never automatically replayed, including after restart', async () => {
  const f = await setup();
  try {
    let attempts = 0;
    f.scheduler.configure = async () => {
      attempts++;
      throw new Error('Connection lost after sending');
    };
    await assert.rejects(f.rules.create(value()), /saved.*uncertain/);
    const rule = (await f.repository.list('telegram:1', undefined, 0, 20)).items[0];
    assert.equal(rule.scheduler_state, 'uncertain');
    assert.equal((await f.rules.inspect('telegram:1', rule.id)).scheduler_state, 'uncertain');
    await f.rules.migrateLegacy();
    await f.repository.initialize();
    await f.rules.migrateLegacy();
    assert.equal(attempts, 1);
  } finally {
    await f.close();
  }
});

test('legacy rules migrate once, missed deadlines expire, and interrupted installs are not replayed', async () => {
  const f = await setup();
  try {
    const future = await f.repository.create(value());
    const missed = await f.repository.create(
      value({ next_at: new Date(Date.now() - 120000).toISOString() }),
    );
    const interrupted = await f.repository.create(value({ scheduler_state: 'installing' }));
    await f.repository.initialize(false);
    assert.equal(
      (await f.repository.read('telegram:1', interrupted.id))?.scheduler_state,
      'installing',
    );
    await f.repository.initialize();
    await f.rules.migrateLegacy();
    await f.rules.migrateLegacy();
    assert.equal(f.configurations.length, 2);
    assert.equal((await f.repository.read('telegram:1', future.id))?.scheduler_state, 'installed');
    assert.equal((await f.repository.read('telegram:1', missed.id))?.status, 'expired');
    assert.equal(
      (await f.repository.read('telegram:1', interrupted.id))?.scheduler_state,
      'uncertain',
    );
  } finally {
    await f.close();
  }
});

test('tools preserve names and expose remote receipts; HTTP chats cannot schedule notifications', async () => {
  const f = await setup();
  try {
    const tools = new Tools(f.store);
    registerNotificationTools(tools, f.rules);
    const context = { session: 'telegram:1', jobId: 'test', signal: AbortSignal.timeout(10000) };
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
    const read = (await tools.call('reminder_get', { id: created.id }, context)) as any;
    assert.equal(read.home_assistant.status, 'active');
    assert.equal(read.scheduler_state, 'installed');
    f.scheduler.ready = async () => {
      throw new Error('Integration is not ready');
    };
    await assert.rejects(
      tools.call('timer_start', { message: 'Tea', duration_seconds: 60 }, context),
      /not ready/,
    );
    assert.equal((await f.repository.list(context.session, undefined, 0, 20)).total, 1);
  } finally {
    await f.close();
  }
});

test('HA callback has a scoped bearer and payload; old heartbeat route cannot trigger evaluation', async () => {
  const f = await fixture();
  const events: unknown[] = [];
  const server = createHttpServer(f.config, f.store, undefined, undefined, undefined, {
    async receive(event) {
      events.push(event);
      return true;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = {
    Authorization: `Bearer ${rulesToken(f.config.apiKey)}`,
    'Content-Type': 'application/json',
  };
  const event = {
    id: randomUUID(),
    generation: 0,
    event_id: randomUUID(),
    fired_at: new Date().toISOString(),
  };
  try {
    assert.equal(
      (
        await fetch(base + '/v1/triggers/rule-events', {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${f.config.apiKey}` },
          body: JSON.stringify(event),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + '/v1/triggers/rule-events', {
          method: 'POST',
          headers,
          body: JSON.stringify(event),
        })
      ).status,
      202,
    );
    assert.equal(events.length, 1);
    assert.equal(
      (
        await fetch(base + '/v1/triggers/rule-events', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...event, chatId: '2' }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(base + '/v1/triggers/rules', { method: 'POST', headers })).status,
      401,
    );
    assert.equal((await fetch(base + '/v1/chat', { method: 'POST', headers })).status, 401);
  } finally {
    server.close();
    await once(server, 'close');
    await f.close();
  }
});

test('scheduler adapter sends only rule configuration, with configured weather entity and no recipient or model-supplied callback', async () => {
  const f = await fixture();
  const requests: { method?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ method: req.method, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.method === 'GET'
          ? { protocol: 2, ready: true }
          : { id: body.id, generation: body.generation },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const scheduler = new HomeAssistantRuleScheduler({
      ...f.config.homeAssistant,
      token: 'test',
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      weatherEntity: 'weather.home',
    });
    await scheduler.ready();
    const rule = {
      ...value({
        kind: 'alert',
        next_at: null,
        condition: { source: 'weather', horizon_hours: 24, minimum_probability: 30 },
      }),
      id: randomUUID(),
      version: 0,
      generation: 2,
    };
    await scheduler.configure(rule);
    assert.equal(requests[1].body.condition.entity_id, 'weather.home');
    assert.equal(requests[1].body.session, undefined);
    assert.equal(requests[1].body.message, undefined);
    assert.equal(requests[1].body.callback_url, undefined);
    const restricted = new HomeAssistantRuleScheduler({
      ...f.config.homeAssistant,
      token: 'test',
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      sensorEntities: ['sensor.allowed'],
    });
    await assert.rejects(
      restricted.configure({
        ...rule,
        condition: { entity_id: 'sensor.forbidden', operator: 'above', value: 10, hold_seconds: 0 },
      }),
      /no longer permitted/,
    );
    assert.equal(requests.length, 2);
  } finally {
    server.close();
    await once(server, 'close');
    await f.close();
  }
});

test('recurring reminders recover at the current occurrence after a lost callback without replaying missed ones', async () => {
  const f = await setup();
  try {
    const now = Date.now();
    const rule = await f.rules.create(
      value({ next_at: new Date(now - 2 * 3600000).toISOString(), repeat_seconds: 3600 }),
    );
    assert.equal(
      await f.rules.receive({
        id: rule.id,
        generation: 0,
        event_id: randomUUID(),
        fired_at: new Date(now).toISOString(),
      }),
      true,
    );
    assert.equal(
      (await f.repository.read('telegram:1', rule.id))?.next_at,
      new Date(now + 3600000).toISOString(),
    );
    assert.equal((await f.store.pool.query('SELECT count(*) FROM jobs')).rows[0].count, '1');
  } finally {
    await f.close();
  }
});

test('changing the HA connection invalidates callbacks from the old integration', async () => {
  const f = await setup();
  try {
    Object.defineProperty(f.scheduler, 'identity', { value: 'first-connection', writable: true });
    const rule = await f.rules.create(value({ next_at: new Date().toISOString() }));
    Object.defineProperty(f.scheduler, 'identity', { value: 'different-connection' });
    assert.equal(
      await f.rules.receive({
        id: rule.id,
        generation: 0,
        event_id: randomUUID(),
        fired_at: new Date().toISOString(),
      }),
      false,
    );
    assert.equal((await f.store.pool.query('SELECT count(*) FROM jobs')).rows[0].count, '0');
  } finally {
    await f.close();
  }
});

test('weather alerts default to all changes and validate explicit storm/rain filters', async () => {
  const f = await setup();
  try {
    const tools = new Tools(f.store);
    registerNotificationTools(tools, f.rules, {} as any);
    const context = { session: 'telegram:1', jobId: 'test', signal: AbortSignal.timeout(10000) };
    await tools.call('weather_alert_create', { message: 'Forecast changed' }, context);
    assert.equal((f.configurations.at(-1)?.condition as any).mode, 'any_change');
    await tools.call(
      'weather_alert_create',
      {
        message: 'Storm forecast',
        mode: 'conditions',
        conditions: ['lightning', 'lightning-rainy'],
      },
      context,
    );
    assert.deepEqual((f.configurations.at(-1)?.condition as any).conditions, [
      'lightning',
      'lightning-rainy',
    ]);
    await tools.call('weather_alert_create', { message: 'Rain forecast', mode: 'rain' }, context);
    assert.equal((f.configurations.at(-1)?.condition as any).mode, 'rain');
    await assert.rejects(
      tools.call('weather_alert_create', { message: 'Invalid', mode: 'conditions' }, context),
      /at least one condition/,
    );
    await assert.rejects(
      tools.call(
        'weather_alert_create',
        { message: 'Invalid', conditions: ['lightning'] },
        context,
      ),
      /only for conditions mode/,
    );
    assert.equal(f.configurations.length, 3);
  } finally {
    await f.close();
  }
});

test('owner weather is enabled once, persists across startups and never replays uncertain setup', async () => {
  const f = await setup();
  try {
    const results = await Promise.all([
      f.rules.ensureOwnerWeather('telegram:1'),
      f.rules.ensureOwnerWeather('telegram:1'),
    ]);
    assert.equal(results[0]?.id, results[1]?.id);
    assert.equal(f.configurations.length, 1);
    const rule = (await f.repository.list('telegram:1', 'alert', 0, 20)).items[0];
    assert.equal(rule.managed, 'owner_weather');
    assert.equal(rule.cooldown_seconds, 1800);
    assert.equal((rule.condition as any).sleep_entity, 'input_boolean.dormir');
    assert.equal((rule.condition as any).mode, 'any_change');
    await f.rules.ensureOwnerWeather('telegram:1');
    assert.equal(f.configurations.length, 1);
    f.scheduler.configure = async () => {
      throw new Error('Write result unknown');
    };
    await assert.rejects(f.rules.ensureOwnerWeather('telegram:2'), /uncertain/);
    f.scheduler.configure = async () => {
      throw new Error('Must not replay');
    };
    assert.equal((await f.rules.ensureOwnerWeather('telegram:2'))?.scheduler_state, 'uncertain');
  } finally {
    await f.close();
  }
});

test('sleep suppresses weather callbacks and notifications already queued while awake', async () => {
  const f = await setup();
  try {
    const rule = (await f.rules.ensureOwnerWeather('telegram:1'))!;
    let muted = true;
    f.scheduler.inspect = async () => ({
      generation: rule.generation,
      status: 'active',
      next_at: null,
      muted,
    });
    const event = {
      id: rule.id,
      generation: rule.generation,
      event_id: randomUUID(),
      fired_at: new Date().toISOString(),
    };
    assert.equal(await f.rules.receive(event), false);
    muted = false;
    assert.equal(await f.rules.receive(event), true);
    const job = await f.store.claim([]);
    assert.match((await f.rules.notification(job!)).output, /previsión/);
    muted = true;
    assert.equal((await f.rules.notification(job!)).deliver, false);
    assert.equal(await f.rules.canNotify(rule), false);
    f.scheduler.inspect = async () => {
      throw new Error('HA offline');
    };
    assert.equal(await f.rules.canNotify(rule), false);
  } finally {
    await f.close();
  }
});

test('weather discovery chooses the sole daily source and rejects ambiguity before writing', async () => {
  const f = await fixture();
  let sources = [{ entity_id: 'weather.forecast_home', attributes: { supported_features: 1 } }];
  let writes = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/states') {
      res.end(JSON.stringify(sources));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    writes++;
    assert.equal(body.condition.entity_id, 'weather.forecast_home');
    res.end(JSON.stringify({ id: body.id, generation: body.generation, status: body.status }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const scheduler = new HomeAssistantRuleScheduler({
      ...f.config.homeAssistant,
      token: 'test',
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      weatherEntity: '',
    });
    const rule = {
      ...value({
        kind: 'alert',
        next_at: null,
        condition: {
          source: 'weather',
          mode: 'any_change',
          horizon_hours: 24,
          minimum_probability: 30,
        },
      }),
      id: randomUUID(),
      version: 0,
      generation: 0,
    };
    await scheduler.configure(rule);
    sources.push({ entity_id: 'weather.other', attributes: { supported_features: 1 } });
    await assert.rejects(scheduler.configure(rule), /exactly one daily forecast/);
    assert.equal(writes, 1);
  } finally {
    server.close();
    await once(server, 'close');
    await f.close();
  }
});

test('owner hourly upgrade is capability-gated, claimed once and preserves paused or uncertain installations', async () => {
  const f = await setup();
  try {
    const original = (await f.rules.ensureOwnerWeather('telegram:1'))!;
    await f.rules.ensureOwnerWeather('telegram:2');
    await f.rules.change(
      'telegram:2',
      (await f.repository.list('telegram:2', 'alert', 0, 1)).items[0]!.id,
      'pause',
    );
    const uncertain = (await f.rules.ensureOwnerWeather('telegram:3'))!;
    uncertain.scheduler_state = 'uncertain';
    assert(await f.repository.apply(uncertain));
    const before = f.configurations.length;
    f.scheduler.supportsHourlyUpdates = async () => true;
    await Promise.all([
      f.rules.ensureOwnerWeather('telegram:1'),
      f.rules.ensureOwnerWeather('telegram:1'),
    ]);
    const upgraded = (await f.repository.read('telegram:1', original.id))!;
    assert.equal(upgraded.generation, original.generation + 1);
    assert.equal((upgraded.condition as any).hourly_updates, true);
    assert.equal(f.configurations.length, before + 1);
    await f.rules.ensureOwnerWeather('telegram:1');
    await f.rules.ensureOwnerWeather('telegram:2');
    await f.rules.ensureOwnerWeather('telegram:3');
    assert.equal(f.configurations.length, before + 1);
    assert.equal(
      (await f.repository.read('telegram:3', uncertain.id))?.scheduler_state,
      'uncertain',
    );
  } finally {
    await f.close();
  }
});

test('hourly queue receipts have independent cooldowns, reject unconfigured hourly sources and preserve suppressed delivery', async () => {
  const f = await setup();
  try {
    const rule = await f.rules.create(
      value({
        kind: 'alert',
        next_at: null,
        recurring: true,
        condition: {
          source: 'weather',
          hourly_updates: true,
          mode: 'any_change',
          horizon_hours: 24,
          minimum_probability: 30,
        },
      }),
    );
    const fired_at = new Date().toISOString();
    const weather = {
      entity_id: 'weather.home',
      units: {},
      changes: [
        { datetime: fired_at, before: { condition: 'sunny' }, after: { condition: 'rainy' } },
      ],
      truncated: false,
    };
    const daily = {
      id: rule.id,
      generation: rule.generation,
      event_id: randomUUID(),
      fired_at,
      weather,
    };
    const hourly = {
      ...daily,
      event_id: randomUUID(),
      weather: { ...weather, forecast_type: 'hourly' as const },
    };
    assert(await f.rules.receive(daily));
    assert(await f.rules.receive(hourly));
    assert(!(await f.rules.receive(hourly)));
    assert(!(await f.rules.receive({ ...hourly, event_id: randomUUID() })));
    const jobs = (await f.store.pool.query('SELECT * FROM jobs ORDER BY sequence')).rows;
    assert.equal(jobs.length, 2);
    const skipped = await f.rules.notification(jobs[1], async () => ({
      output: '',
      deliver: false,
    }));
    assert.equal(skipped.deliver, false);
    assert.equal(skipped.output, '');
    const legacy = await f.rules.create(
      value({
        kind: 'alert',
        next_at: null,
        recurring: true,
        condition: {
          source: 'weather',
          mode: 'any_change',
          horizon_hours: 24,
          minimum_probability: 30,
        },
      }),
    );
    assert(
      !(await f.rules.receive({
        ...hourly,
        id: legacy.id,
        generation: legacy.generation,
        event_id: randomUUID(),
      })),
    );
  } finally {
    await f.close();
  }
});

test('wake reminders use local dates, stay scoped, and never install a timed HA rule', async () => {
  const f = await setup();
  try {
    const rules = new NotificationRules(
      f.repository,
      async () => ({ enabled: true, scheduler: f.scheduler }),
      'telegram:1',
      () => '2026-10-19',
    );
    const tools = new Tools(f.store);
    registerNotificationTools(tools, rules);
    const context = {
      session: 'telegram:1',
      jobId: 'wake-test',
      signal: new AbortController().signal,
    };
    const receipt = (await tools.call(
      'wake_reminder_create',
      { message: 'Buy chicken', date: '2026-10-21' },
      context,
    )) as any;
    assert.equal(receipt.wake_date, '2026-10-21');
    assert.equal(receipt.next_at, null);
    assert.equal(f.configurations.length, 0);
    assert.equal((await f.repository.wakeReminders('telegram:1', '2026-10-20')).length, 0);
    assert.equal((await f.repository.wakeReminders('telegram:2', '2026-10-21')).length, 0);
    const due = await f.repository.wakeReminders('telegram:1', '2026-10-21');
    assert.equal(due.length, 1);
    assert.equal(
      await rules.receive({
        id: receipt.id,
        generation: 0,
        event_id: randomUUID(),
        fired_at: new Date().toISOString(),
      }),
      false,
    );
    await assert.rejects(() =>
      tools.call('wake_reminder_create', { message: 'past', date: '2026-10-18' }, context),
    );
    await assert.rejects(() =>
      tools.call(
        'wake_reminder_create',
        { message: 'other', date: '2026-10-21' },
        { ...context, session: 'telegram:2' },
      ),
    );
    await rules.change(context.session, receipt.id, 'pause');
    assert.equal((await f.repository.wakeReminders(context.session, '2026-10-21')).length, 0);
    await rules.change(context.session, receipt.id, 'resume');
    await assert.rejects(() => rules.change(context.session, receipt.id, 'snooze', 60));
    assert.equal((await f.repository.read(context.session, receipt.id))?.next_at, null);
    // A stale delivery receipt must not complete a changed rule.
    await f.repository.completeWakeReminders(context.session, due);
    const resumed = await f.repository.wakeReminders(context.session, '2026-10-21');
    assert.equal(resumed.length, 1);
    await f.repository.completeWakeReminders(context.session, resumed);
    assert.equal((await f.repository.read(context.session, receipt.id))?.status, 'completed');
    assert.equal(f.configurations.length, 0);
  } finally {
    await f.close();
  }
});
