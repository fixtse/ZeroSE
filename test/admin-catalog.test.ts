import { assistExposureFixture } from './assist-exposure-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Admin } from '../src/adapters/inbound/admin.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import type { AccessRepository } from '../src/application/access.js';
import type { NotificationRules, RuleRepository } from '../src/application/notification-rules.js';
import type { AccessProfile } from '../src/domain/access.js';

function setup() {
  const config = ConfigSchema.parse({});
  const profile: AccessProfile = {
    bot: 'helper',
    chatId: '123',
    kind: 'user',
    label: 'Test',
    enabled: true,
    capabilities: ['homeAssistant', 'calendar'],
    owner: false,
    homeAssistant: {
      ...config.homeAssistant,
      url: 'https://ha.example',
      token: 'private-ha-token',
    },
    google: {
      ...config.google,
      credentials: {
        calendar: {
          clientId: 'calendar-id',
          clientSecret: 'private-client',
          refreshToken: 'private-refresh',
        },
        drive: {
          clientId: 'drive-id',
          clientSecret: 'drive-secret',
          refreshToken: 'drive-refresh',
        },
      },
    },
  };
  const repository = {
    async profile(bot: string, chat: string) {
      return bot === profile.bot && chat === profile.chatId ? profile : undefined;
    },
    async saveProfile(value: AccessProfile) {
      Object.assign(profile, value);
    },
  } as unknown as AccessRepository;
  return { config, profile, repository };
}
async function request(admin: Admin, path: string, method = 'GET', body?: unknown) {
  const url = '/v1/admin/profiles/' + path;
  let status = 0,
    value: any;
  await admin.handle(
    { method, url } as IncomingMessage,
    url.split('?')[0],
    async () => body,
    (code, result) => {
      status = code;
      value = result;
    },
  );
  return { status, value };
}

test('admin catalogs use the saved chat connection, bounded query and isolated rule session', async () => {
  const f = setup();
  const calls: unknown[] = [];
  const admin = new Admin(
    f.config,
    f.repository,
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    (scoped) => {
      assert.equal(scoped.homeAssistant.token, 'private-ha-token');
      return {
        async entities(query) {
          calls.push(query);
          return { items: [{ id: 'sensor.test', name: 'Test', access: ['sensor'] }], total: 1 };
        },
        async services() {
          return { items: [{ id: 'light.turn_on', name: 'Turn on' }], total: 1 };
        },
      };
    },
    {
      async list(...args: unknown[]) {
        calls.push(args);
        return { items: [], total: 0, next_offset: null };
      },
    } as unknown as RuleRepository,
  );
  assert.equal(
    (await request(admin, 'helper/123/entities?search=test&limit=5&offset=2')).status,
    200,
  );
  assert.deepEqual(calls[0], { search: 'test', limit: 5, offset: 2 });
  assert.equal(
    (await request(admin, 'helper/123/entities?search=todo.&domains=todo&limit=5&offset=2')).status,
    200,
  );
  assert.deepEqual(calls[1], { search: 'todo.', domains: 'todo', limit: 5, offset: 2 });
  await assert.rejects(request(admin, 'helper/123/entities?domains=todo.*'));

  assert.equal((await request(admin, 'helper/123/services')).value.items[0].id, 'light.turn_on');
  assert.equal((await request(admin, 'helper/123/rules?kind=alert&offset=3')).status, 200);
  assert.deepEqual(calls[2], [
    'helper:123',
    'alert',
    3,
    20,
    { includeAlerts: true, excludeCancelled: true, excludeManaged: true },
  ]);
  assert.equal((await request(admin, 'zero/123/rules')).status, 404);
  await assert.rejects(request(admin, 'helper/123/entities?limit=51'));
  f.profile.capabilities = [];
  assert.equal((await request(admin, 'helper/123/entities')).status, 400);
});

test('service credential edits preserve blank secrets and other services without exposing secrets', async () => {
  const f = setup();
  const admin = new Admin(f.config, f.repository, async () => {});
  const input = {
    kind: 'user',
    label: 'Test',
    enabled: true,
    capabilities: ['calendar'],
    google: {
      credentials: { calendar: { clientId: 'updated-id', clientSecret: '', refreshToken: '' } },
    },
  };
  assert.equal((await request(admin, 'helper/123', 'PUT', input)).status, 200);
  assert.equal(f.profile.google?.credentials.calendar?.clientId, 'updated-id');
  assert.equal(f.profile.google?.credentials.calendar?.clientSecret, 'private-client');
  assert.equal(f.profile.google?.credentials.calendar?.refreshToken, 'private-refresh');
  assert.equal(f.profile.google?.credentials.drive?.refreshToken, 'drive-refresh');
  const result = await request(admin, 'helper/123');
  assert.equal(result.value.google.credentials.calendar.configured, true);
  assert(!JSON.stringify(result.value).includes('private-'));
  assert(!JSON.stringify(result.value).includes('drive-secret'));
  assert(!JSON.stringify(result.value).includes('drive-refresh'));
});

test('task provider changes retain direct credentials without an extra confirmation', async () => {
  const f = setup();
  const admin = new Admin(f.config, f.repository, async () => {});
  const input = {
    kind: 'user',
    label: 'Test',
    enabled: true,
    capabilities: ['tasks', 'homeAssistant'],
    homeAssistant: {
      url: 'https://ha.example',
      taskProvider: 'home_assistant',
      taskListEntity: 'todo.personal',
    },
    confirmTaskProviderChange: false,
  };
  assert.equal((await request(admin, 'helper/123', 'PUT', input)).status, 200);
  assert.equal(f.profile.homeAssistant?.taskProvider, 'home_assistant');
  assert.equal(f.profile.homeAssistant?.token, 'private-ha-token');
  assert.equal(f.profile.google?.credentials.drive?.refreshToken, 'drive-refresh');
  const result = await request(admin, 'helper/123');
  assert.equal(result.value.homeAssistant.taskListEntity, 'todo.personal');
  assert(!JSON.stringify(result.value).includes('private-ha-token'));
  input.homeAssistant.taskProvider = 'google';
  input.confirmTaskProviderChange = false;
  assert.equal((await request(admin, 'helper/123', 'PUT', input)).status, 200);
  input.homeAssistant.taskProvider = 'home_assistant';
  assert.equal(
    (
      await request(admin, 'helper/123', 'PUT', {
        ...input,
        homeAssistant: { ...input.homeAssistant, taskListEntity: '' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(admin, 'helper/123', 'PUT', {
        ...input,
        clearHomeAssistant: true,
      })
    ).status,
    200,
  );
  assert.equal(f.profile.homeAssistant?.taskProvider, 'home_assistant');
  assert.equal(f.profile.homeAssistant?.token, '');
  assert.equal(f.profile.google?.credentials.drive?.refreshToken, 'drive-refresh');
});

test('groups explicitly reuse configured HA credentials with their own location entities', async () => {
  const f = setup();
  f.profile.kind = 'group';
  f.profile.chatId = '-123';
  Object.assign(f.profile, { homeAssistant: undefined });
  const shared = {
    ...f.config.homeAssistant,
    url: 'https://shared-ha.example',
    token: 'shared-private-token',
    locationEntity: 'person.owner',
    geocodedLocationEntity: 'sensor.owner_address',
    sensorEntities: ['sensor.private'],
  };
  const admin = new Admin(f.config, f.repository, async () => {}).withHomeAssistantConnection(
    async () => shared,
  );
  const input = {
    kind: 'group',
    label: 'Family',
    enabled: true,
    capabilities: ['homeAssistant'],
    useConfiguredHomeAssistant: true,
    homeAssistant: {
      locationEntity: 'person.family',
      geocodedLocationEntity: 'sensor.family_address',
    },
  };
  assert.equal((await request(admin, 'helper/-123', 'PUT', input)).status, 200);
  assert.equal(f.profile.homeAssistant?.url, shared.url);
  assert.equal(f.profile.homeAssistant?.token, shared.token);
  assert.equal(f.profile.homeAssistant?.locationEntity, 'person.family');
  assert.equal(f.profile.homeAssistant?.geocodedLocationEntity, 'sensor.family_address');
  assert.deepEqual(f.profile.homeAssistant?.sensorEntities, []);
  const result = await request(admin, 'helper/-123');
  assert.equal(result.value.hasHomeAssistant, true);
  assert.equal(result.value.homeAssistant.sensorEntities, undefined);
  assert(!JSON.stringify(result.value).includes(shared.token));
  assert.equal(shared.locationEntity, 'person.owner');
  assert.equal(
    (await request(admin, 'helper/-123', 'PUT', { ...input, capabilities: [] })).status,
    400,
  );
  assert.equal(
    (await request(admin, 'helper/-123', 'PUT', { ...input, clearHomeAssistant: true })).status,
    400,
  );
  await assert.rejects(() =>
    request(admin, 'helper/-123', 'PUT', {
      ...input,
      homeAssistant: { locationEntity: 'light.invalid' },
    }),
  );
  f.profile.kind = 'user';
  f.profile.chatId = '123';
  assert.equal((await request(admin, 'helper/123', 'PUT', { ...input, kind: 'user' })).status, 400);
});

test('configured HA discovery returns only availability and rejects missing connections', async () => {
  const f = setup();
  f.profile.kind = 'group';
  f.profile.chatId = '-123';
  const admin = new Admin(f.config, f.repository, async () => {});
  let result: unknown;
  await admin.handle(
    { method: 'GET' } as IncomingMessage,
    '/v1/admin/home-assistant/connection',
    async () => undefined,
    (_status, value) => {
      result = value;
    },
  );
  assert.deepEqual(result, { available: false });
  assert.equal(
    (
      await request(admin, 'helper/-123', 'PUT', {
        kind: 'group',
        label: 'Family',
        enabled: true,
        capabilities: ['homeAssistant'],
        useConfiguredHomeAssistant: true,
      })
    ).status,
    400,
  );
});

test('HA users can edit their connection and retain credentials when input is blank', async () => {
  const f = setup();
  f.profile.chatId = 'ha:' + 'a'.repeat(32);
  f.profile.homeAssistant!.voiceSatellite = 'assist_satellite.kitchen';
  const admin = new Admin(f.config, f.repository, async () => {});
  const input = {
    kind: 'user',
    label: 'Test',
    enabled: true,
    capabilities: ['homeAssistant'],
    homeAssistant: {
      locationEntity: 'person.ana',
      geocodedLocationEntity: 'sensor.ana_address',
      weatherEntity: 'weather.home',
    },
  };
  assert.equal((await request(admin, 'helper/' + f.profile.chatId, 'PUT', input)).status, 200);
  assert.equal(f.profile.homeAssistant?.locationEntity, 'person.ana');
  assert.equal(f.profile.homeAssistant?.geocodedLocationEntity, 'sensor.ana_address');
  assert.equal(f.profile.homeAssistant?.url, 'https://ha.example');
  assert.equal(f.profile.homeAssistant?.token, 'private-ha-token');
  assert.equal(f.profile.homeAssistant?.voiceSatellite, 'assist_satellite.kitchen');
  assert.equal(
    (
      await request(admin, 'helper/' + f.profile.chatId, 'PUT', {
        ...input,
        homeAssistant: { ...input.homeAssistant, token: 'replacement' },
      })
    ).status,
    200,
  );
  assert.equal(f.profile.homeAssistant?.token, 'replacement');
  assert.equal(
    (
      await request(admin, 'helper/' + f.profile.chatId, 'PUT', {
        ...input,
        homeAssistant: { ...input.homeAssistant, token: '', url: 'https://other-ha.example' },
      })
    ).status,
    200,
  );
  assert.equal(f.profile.homeAssistant?.token, 'replacement');
  assert.equal(f.profile.homeAssistant?.url, 'https://other-ha.example');
});

test('entity catalogs filter domains before pagination', async (t) => {
  const { HomeAssistant } = await import('../src/adapters/outbound/home-assistant.js');
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json([
      { entity_id: 'sensor.first', attributes: {} },
      { entity_id: 'person.ana', attributes: { friendly_name: 'Ana' } },
      { entity_id: 'device_tracker.phone', attributes: { friendly_name: 'Phone' } },
      { entity_id: 'sensor.last', attributes: {} },
    ]),
  );
  const config = ConfigSchema.parse({
    homeAssistant: { url: 'https://ha.example', token: 'test-only' },
  });
  const page = await new HomeAssistant(config.homeAssistant, assistExposureFixture()).entityCatalog(
    { search: '', domains: 'person,device_tracker', offset: 1, limit: 1 },
    AbortSignal.timeout(1000),
  );
  assert.equal(page.total, 2);
  assert.equal(page.items[0].id, 'device_tracker.phone');
});

test('admin entity prefix search returns every matching domain across bounded pages', async (t) => {
  const { HomeAssistant } = await import('../src/adapters/outbound/home-assistant.js');
  const f = setup();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json([
      { entity_id: 'sensor.unrelated', attributes: { friendly_name: 'todo. should not match' } },
      ...Array.from({ length: 25 }, (_, index) => ({
        entity_id: 'todo.list_' + index,
        attributes: { friendly_name: 'Lista ' + index },
      })),
      { entity_id: 'weather.home', attributes: { friendly_name: 'Casa' } },
    ]),
  );
  const admin = new Admin(
    f.config,
    f.repository,
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    (config) => {
      const ha = new HomeAssistant(config.homeAssistant, assistExposureFixture());
      return {
        entities: (query, signal) => ha.entityCatalog(query, signal),
        services: async () => ({ items: [], total: 0 }),
      };
    },
  );
  const first = await request(admin, 'helper/123/entities?search=todo.&domains=todo&limit=20');
  const second = await request(
    admin,
    'helper/123/entities?search=todo.&domains=todo&limit=20&offset=20',
  );
  assert.equal(first.status, 200);
  assert.equal(first.value.total, 25);
  assert.equal(first.value.items.length, 20);
  assert.equal(second.value.total, 25);
  assert.equal(second.value.items.length, 5);
  assert(
    [...first.value.items, ...second.value.items].every((item) => item.id.startsWith('todo.')),
  );
});

test('profiles select several Zero connections and use only the chosen active server', async () => {
  const f = setup();
  const connections = [
    {
      id: 'telegram:1',
      name: 'Home',
      connection: {
        ...f.config.homeAssistant,
        url: 'https://home.example',
        token: 'home-private-token',
      },
    },
    {
      id: 'telegram:2',
      name: 'Cabin',
      connection: {
        ...f.config.homeAssistant,
        url: 'https://cabin.example',
        token: 'cabin-private-token',
      },
    },
  ];
  const admin = new Admin(f.config, f.repository, async () => {}).withHomeAssistantConnections({
    async list() {
      return connections;
    },
  });
  const input = {
    kind: 'user',
    label: 'Test',
    enabled: true,
    capabilities: ['homeAssistant'],
    homeAssistantConnectionIds: connections.map((item) => item.id),
    activeHomeAssistantConnectionId: 'telegram:2',
    homeAssistant: { weatherEntity: 'weather.home' },
  };
  assert.equal((await request(admin, 'helper/123', 'PUT', input)).status, 200);
  assert.equal(f.profile.homeAssistant?.url, 'https://cabin.example');
  assert.equal(f.profile.homeAssistant?.token, 'cabin-private-token');
  assert.equal(f.profile.homeAssistant?.connections?.length, 2);
  assert.equal(f.profile.homeAssistant?.weatherEntity, 'weather.home');
  assert.equal(
    (
      await request(admin, 'helper/123', 'PUT', {
        ...input,
        activeHomeAssistantConnectionId: 'telegram:1',
      })
    ).status,
    200,
  );
  assert.equal(f.profile.homeAssistant?.token, 'home-private-token');
  const publicValue = JSON.stringify((await request(admin, 'helper/123')).value);
  assert(!publicValue.includes('home-private-token'));
  assert(!publicValue.includes('cabin-private-token'));
  assert.equal(
    (
      await request(admin, 'helper/123', 'PUT', {
        ...input,
        activeHomeAssistantConnectionId: 'unknown',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(admin, 'helper/123', 'PUT', {
        ...input,
        homeAssistantConnectionIds: ['missing'],
      })
    ).status,
    400,
  );
  assert.equal(f.profile.homeAssistant?.token, 'home-private-token');
  let result: any;
  await admin.handle(
    {
      method: 'GET',
      url: '/v1/admin/home-assistant/connections?search=cabin&limit=1',
    } as IncomingMessage,
    '/v1/admin/home-assistant/connections',
    async () => undefined,
    (status, value) => {
      assert.equal(status, 200);
      result = value;
    },
  );
  assert.deepEqual(result, {
    items: [
      {
        id: 'telegram:2',
        name: 'Cabin',
        url: 'https://cabin.example',
        tokenHint: 'cabi••••••••oken',
        version: undefined,
      },
    ],
    total: 1,
    next_offset: null,
  });
  assert(!JSON.stringify(result).includes('private-token'));
});

test('profile notification preferences round trip without exposing the compatibility binding', async () => {
  const f = setup();
  f.profile.morningCallbackTrigger = { entity: 'input_boolean.sleep', state: 'off' };
  const admin = new Admin(f.config, f.repository, async () => {});
  const notifications = {
    eventReminders: true,
    eventReminderMinutes: 20,
    reset: { enabled: false, time: '04:00' },
    morning: { mode: 'entity', time: '08:30', entity: 'input_boolean.sleep', state: 'off' },
  };
  const saved = await request(admin, 'helper/123', 'PUT', {
    kind: 'user',
    label: 'Test',
    enabled: true,
    capabilities: ['calendar', 'homeAssistant'],
    notifications,
  });
  assert.equal(saved.status, 200);
  const result = await request(admin, 'helper/123');
  assert.deepEqual(result.value.notifications, {
    ...notifications,
    weather: { mode: 'off', routineIntervalHours: 6 },
  });
  for (const eventReminderMinutes of [0, 1441, 1.5]) {
    await assert.rejects(
      request(admin, 'helper/123', 'PUT', {
        kind: 'user',
        label: 'Test',
        enabled: true,
        capabilities: ['calendar', 'homeAssistant'],
        notifications: { ...notifications, eventReminderMinutes },
      }),
    );
  }

  assert.equal(result.value.morningCallbackTrigger, undefined);
  assert.deepEqual(f.profile.morningCallbackTrigger, {
    entity: 'input_boolean.sleep',
    state: 'off',
  });
});

test('removing every saved HA selection clears credentials and keeps them cleared after reload and save', async () => {
  const f = setup();
  f.profile.homeAssistant = {
    ...f.profile.homeAssistant!,
    connections: [{ id: 'telegram:1', name: 'House', url: 'https://ha.example' }],
    activeConnectionId: 'telegram:1',
  };
  const admin = new Admin(f.config, f.repository, async () => {});
  const input = {
    kind: 'user',
    label: 'Test',
    enabled: true,
    capabilities: ['homeAssistant'],
    homeAssistantConnectionIds: [],
    homeAssistant: { url: 'https://ha.example', token: '' },
  };
  assert.equal((await request(admin, 'helper/123', 'PUT', input)).status, 200);
  assert.equal(f.profile.homeAssistant?.token, '');
  assert.equal(f.profile.homeAssistant?.url, '');
  const reloaded = (await request(admin, 'helper/123')).value;
  assert.equal(reloaded.hasHomeAssistant, false);
  assert.equal(reloaded.homeAssistant.tokenHint, undefined);
  assert.equal(
    (await request(admin, 'helper/123', 'PUT', { ...input, homeAssistant: { url: '', token: '' } }))
      .status,
    200,
  );
  assert.equal((await request(admin, 'helper/123')).value.hasHomeAssistant, false);
});

test('uncertain scheduler permits explicit deletion but blocks other changes', async () => {
  const f = setup();
  const id = '02804239-2882-44dc-86f5-4f103f7af410';
  const calls: string[] = [];
  const rule = { id, scheduler_state: 'uncertain' };
  const notifications = {
    repository: {
      async read() {
        return rule;
      },
    },
    async confirmScheduler() {
      return { missing: true, version: 7 };
    },
    async recreateAlert(_session: string, ruleId: string, version: number) {
      assert.equal(ruleId, id);
      assert.equal(version, 7);
      calls.push('recreate');
      return { id, status: 'active', scheduler_state: 'installed' };
    },
    async change(_session: string, _id: string, operation: string) {
      calls.push(operation);
      return {
        id,
        status: operation === 'cancel' ? 'cancelled' : 'paused',
        scheduler_state: 'uncertain',
      };
    },
  } as unknown as import('../src/application/notification-rules.js').NotificationRules;
  const admin = new Admin(
    f.config,
    f.repository,
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    notifications,
  );
  const path = 'helper/123/rules/' + id;
  for (const state of ['uncertain', 'installing']) {
    rule.scheduler_state = state;
    assert.equal((await request(admin, path, 'PATCH', { operation: 'resume' })).status, 409);
    assert.equal((await request(admin, path, 'PATCH', { operation: 'pause' })).status, 409);
    const cancelled = await request(admin, path, 'DELETE');
    assert.equal(cancelled.status, 200);
    assert.match(cancelled.value.warning, /Cambio guardado/);
  }
  assert.deepEqual(calls, ['cancel', 'cancel']);
  const confirmed = await request(admin, path, 'PATCH', { operation: 'confirm' });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.value, { missing: true, version: 7 });
  assert.equal((await request(admin, path, 'PATCH', { operation: 'recreate' })).status, 400);
  assert.equal(
    (await request(admin, path, 'PATCH', { operation: 'recreate', version: 7 })).status,
    200,
  );
  assert.deepEqual(calls, ['cancel', 'cancel', 'recreate']);
});

test('profile location assignment waits for explicit global Assist exposure confirmation', async () => {
  const f = setup();
  f.profile.homeAssistant!.sensorEntities = ['sensor.retired'];
  const confirmations: boolean[] = [];
  const admin = new Admin(f.config, f.repository, async () => {}).withLocationExposure(
    async (_connection, ids, confirmed) => {
      confirmations.push(confirmed);
      return confirmed ? { exposed: ids } : { confirmationRequired: ids };
    },
  );
  const input = {
    kind: 'user',
    label: 'Test',
    enabled: true,
    capabilities: ['homeAssistant'],
    homeAssistant: { locationEntity: 'person.ana', geocodedLocationEntity: 'sensor.ana_address' },
  };
  const pending = await request(admin, 'helper/123', 'PUT', input);
  assert.deepEqual(pending.value.confirmationRequired, ['person.ana', 'sensor.ana_address']);
  assert.equal(f.profile.homeAssistant?.locationEntity, '');
  assert.equal(
    (await request(admin, 'helper/123', 'PUT', { ...input, confirmLocationExposure: true })).status,
    200,
  );
  assert.deepEqual(confirmations, [false, true]);
  assert.equal(f.profile.homeAssistant?.locationEntity, 'person.ana');
  assert.deepEqual(f.profile.homeAssistant?.sensorEntities, ['sensor.retired']);
  const visible = await request(admin, 'helper/123');
  assert.equal(visible.value.homeAssistant.sensorEntities, undefined);
});

test('weather preferences round trip, survive older clients and reject invalid intervals', async () => {
  const f = setup();
  const admin = new Admin(f.config, f.repository, async () => {});
  const notifications = {
    eventReminders: false,
    reset: { enabled: false, time: '04:00' },
    morning: { mode: 'off', time: '08:30', entity: '', state: 'off' },
    weather: { mode: 'updates', routineIntervalHours: 6 },
  };
  const input = {
    kind: 'user',
    label: 'Weather',
    enabled: true,
    capabilities: ['homeAssistant'],
    notifications,
  };
  assert.equal((await request(admin, 'helper/123', 'PUT', input)).status, 200);
  assert.deepEqual(
    (await request(admin, 'helper/123')).value.notifications.weather,
    notifications.weather,
  );
  const { weather: _weather, ...older } = notifications;
  assert.equal(
    (await request(admin, 'helper/123', 'PUT', { ...input, notifications: older })).status,
    200,
  );
  assert.deepEqual(
    (await request(admin, 'helper/123')).value.notifications.weather,
    notifications.weather,
  );
  for (const routineIntervalHours of [0, 25, 1.5]) {
    await assert.rejects(
      request(admin, 'helper/123', 'PUT', {
        ...input,
        notifications: { ...notifications, weather: { mode: 'updates', routineIntervalHours } },
      }),
    );
  }
  assert.equal(
    (await request(admin, 'helper/123', 'PUT', { ...input, capabilities: [] })).status,
    400,
  );
});

test('weather health endpoint checks the saved profile session and never provisions on a read', async () => {
  const f = setup();
  const calls: string[] = [];
  const rules = {
    async profileWeatherStatus(session: string, signal: AbortSignal) {
      calls.push(session);
      assert(signal instanceof AbortSignal);
      return { state: 'paused' };
    },
    async ensureProfileWeather() {
      assert.fail('GET must not provision');
    },
  } as unknown as NotificationRules;
  const admin = new Admin(
    f.config,
    f.repository,
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    rules,
  );
  assert.deepEqual(await request(admin, 'helper/123/weather-status'), {
    status: 200,
    value: { state: 'off' },
  });
  assert.equal(calls.length, 0);
  f.profile.notifications = {
    eventReminders: false,
    reset: { enabled: false, time: '04:00' },
    morning: { mode: 'off', time: '08:30', entity: '', state: 'off' },
    weather: { mode: 'all', routineIntervalHours: 6 },
  };
  assert.deepEqual(await request(admin, 'helper/123/weather-status'), {
    status: 200,
    value: { state: 'paused' },
  });
  assert.deepEqual(calls, ['helper:123']);
  assert.equal((await request(admin, 'helper/456/weather-status')).status, 404);
});
