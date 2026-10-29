import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { migrateProfileSchedules } from '../src/application/migrate-profile-schedules.js';
import type { AccessRepository } from '../src/application/access.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { Scheduler } from '../src/application/scheduler.js';
import {
  profileNotifications,
  notificationServices,
} from '../src/application/profile-notifications.js';
import type { AccessProfile } from '../src/domain/access.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import {
  MorningTriggers,
  importMorningTrigger,
  type MorningTriggerPort,
} from '../src/application/morning-triggers.js';
import { HomeAssistantMorningTriggers } from '../src/adapters/outbound/ha-morning-triggers.js';

const profile = (chatId: string): AccessProfile => ({
  bot: 'zero',
  chatId,
  kind: 'user',
  label: chatId,
  enabled: true,
  owner: false,
  capabilities: ['calendar', 'homeAssistant'],
  notifications: {
    reset: { enabled: false, time: '04:00' },
    eventReminders: false,
    morning: { mode: 'off', time: '08:30', entity: '', state: 'off' },
  },
});

test('every new profile defaults to disabled personal schedules, including the owner', () => {
  const p = profile('1');
  delete p.notifications;
  for (const owner of [false, true]) {
    p.owner = owner;
    assert.equal(profileNotifications(p).morning.mode, 'off');
    assert.equal(profileNotifications(p).eventReminders, false);
    assert.equal(profileNotifications(p).reset.enabled, false);
  }
});

test('personal schedules work without global resets, use profile timezone, discover unused chats and deduplicate per profile', async () => {
  const f = await fixture();
  try {
    const scheduler = new Scheduler(
      f.store,
      async (session) => ({
        enabled: session !== 'telegram:4',
        timezone: 'Europe/Madrid',
        calendar: session !== 'telegram:3',
        notifications: {
          reset: { enabled: false, time: '04:00' },
          eventReminders: true,
          morning: {
            mode: session === 'telegram:5' ? 'entity' : 'time',
            time: '08:30',
            entity: 'binary_sensor.sleep',
            state: 'off',
          },
        },
      }),
      async () => ['telegram:1', 'helper:2', 'telegram:3', 'telegram:4', 'telegram:5'],
    );
    await scheduler.tick(new Date('2026-10-15T06:30:00Z'));
    await scheduler.tick(new Date('2026-10-15T06:30:15Z'));
    const jobs = (await f.store.pool.query('SELECT session,payload FROM jobs ORDER BY sequence'))
      .rows;
    assert.deepEqual(
      jobs.filter((j) => j.payload.kind === 'morning').map((j) => j.session),
      ['telegram:1', 'helper:2', 'telegram:3'],
    );
    assert.deepEqual(
      jobs.filter((j) => j.payload.kind === 'event_reminders').map((j) => j.session),
      ['telegram:1', 'helper:2', 'telegram:5'],
    );
  } finally {
    await f.close();
  }
});

test('existing wake-up entity moves to active profile preferences and shares daily deduplication with native events', async () => {
  const f = await fixture();
  try {
    const access = new PostgresAccess(f.store.db, f.config.apiKey);
    const p = profile('1');
    p.owner = true;
    delete p.notifications;
    f.config.telegram.notificationChatId = '1';
    let wake: (() => Promise<void>) | undefined;
    const port: MorningTriggerPort = {
      discover: async () => ({ entity: 'input_boolean.sleep', state: 'off' }),
      watch: (_key, _config, _trigger, callback) => {
        wake = callback;
      },
      retain: () => {},
      close: () => {},
    };
    const repository = {
      profiles: async () => ({ items: [p], total: 1 }),
      saveProfile: async (value: AccessProfile) => access.saveProfile(value),
    } as unknown as AccessRepository;
    await migrateProfileSchedules(
      { schedules: { enabled: true, morning: '', reset: '05:00', eventReminders: true } },
      f.config,
      repository,
      f.store,
      port,
    );
    const saved = (await access.profile('zero', '1'))!;
    // The database intentionally does not permit arbitrary callers to promote owners.
    assert.equal(saved.notifications?.morning.mode, 'entity');
    assert.deepEqual(saved.morningCallbackTrigger, { entity: 'input_boolean.sleep', state: 'off' });
    assert.equal(profileNotifications(p).morning.mode, 'entity');
    assert.deepEqual(profileNotifications(p).reset, { enabled: true, time: '05:00' });
    const triggers = new MorningTriggers(port, f.store);
    f.config.homeAssistant.token = 'test-token';
    triggers.refresh([{ profile: p, config: f.config }]);
    await wake!();
    await wake!();
    const jobs = (await f.store.pool.query('SELECT session,payload FROM jobs')).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].session, 'telegram:1');
    assert.equal(jobs[0].payload.wakeUp, true);
  } finally {
    await f.close();
  }
});

test('native HA triggers authenticate, subscribe to the selected state and never replay startup or unavailable states', async () => {
  const sockets: any[] = [];
  const adapter = new HomeAssistantMorningTriggers(() => {
    const socket: any = {
      sent: [] as string[],
      close() {
        this.closed = true;
      },
      send(data: string) {
        this.sent.push(JSON.parse(data));
      },
    };
    sockets.push(socket);
    return socket;
  });
  const f = await fixture();
  try {
    let wakes = 0;
    const trigger = {
      mode: 'entity' as const,
      time: '08:30',
      entity: 'input_boolean.sleep',
      state: 'off',
    };
    adapter.watch(
      'telegram:2',
      { ...f.config.homeAssistant, url: 'http://ha.test', token: 'private-test-token' },
      trigger,
      async () => {
        wakes++;
      },
    );
    const socket = sockets[0];
    const send = (value: any) => socket.onmessage({ data: JSON.stringify(value) });
    send({ type: 'auth_required' });
    send({ type: 'auth_ok' });
    assert.equal(socket.sent[1].type, 'subscribe_trigger');
    assert.equal(socket.sent[1].trigger.entity_id, trigger.entity);
    send({ type: 'result', id: 1, success: true });
    const event = (from: string | undefined, entity = trigger.entity) => ({
      type: 'event',
      id: 1,
      event: {
        variables: {
          trigger: {
            entity_id: entity,
            from_state: from ? { state: from } : null,
            to_state: { state: 'off' },
          },
        },
      },
    });
    send(event(undefined));
    send(event('unavailable'));
    send(event('off'));
    send(event('on', 'input_boolean.other'));
    assert.equal(wakes, 0);
    send(event('on'));
    assert.equal(wakes, 1);
    socket.onclose();
    adapter.watch(
      'telegram:2',
      { ...f.config.homeAssistant, url: 'http://ha.test', token: 'private-test-token' },
      trigger,
      async () => {
        wakes++;
      },
    );
    assert.equal(sockets.length, 2);
    assert.equal(wakes, 1);
    adapter.retain(new Set());
    assert.equal(sockets[1].closed, true);
  } finally {
    adapter.close();
    await f.close();
  }
});

test('non-admin HA profiles use a single-entity subscription and ignore its initial snapshot', async () => {
  let socket: any;
  const adapter = new HomeAssistantMorningTriggers(() => {
    socket = {
      sent: [] as any[],
      send(data: string) {
        this.sent.push(JSON.parse(data));
      },
      close() {},
    };
    return socket;
  });
  const f = await fixture();
  try {
    let wakes = 0;
    adapter.watch(
      'helper:3',
      { ...f.config.homeAssistant, url: 'http://ha.test', token: 'test-token' },
      { mode: 'entity', time: '08:30', entity: 'input_boolean.sleep', state: 'off' },
      async () => {
        wakes++;
      },
    );
    const send = (value: any) => socket.onmessage({ data: JSON.stringify(value) });
    send({ type: 'auth_ok' });
    send({ type: 'result', id: 1, success: false, error: { code: 'unauthorized' } });
    assert.deepEqual(socket.sent[1], {
      id: 2,
      type: 'subscribe_entities',
      entity_ids: ['input_boolean.sleep'],
    });
    send({ type: 'result', id: 2, success: true });
    send({ type: 'event', id: 2, event: { a: { 'input_boolean.sleep': { s: 'off' } } } });
    assert.equal(wakes, 0);
    const state = (s: string) =>
      send({ type: 'event', id: 2, event: { c: { 'input_boolean.sleep': { '+': { s } } } } });
    state('on');
    state('off');
    assert.equal(wakes, 1);
    state('unavailable');
    state('off');
    assert.equal(wakes, 1);
    state('on');
    state('off');
    assert.equal(wakes, 2);
  } finally {
    adapter.close();
    await f.close();
  }
});

test('notification content uses only this profile’s permitted connected services', () => {
  const config = ConfigSchema.parse({ google: { refreshToken: 'test-refresh' } });
  const p = profile('2');
  p.capabilities = ['calendar'];
  assert.deepEqual(notificationServices(config, p), { calendar: true, tasks: false });
  config.google.refreshToken = '';
  assert.deepEqual(notificationServices(config, p), { calendar: false, tasks: false });
});
