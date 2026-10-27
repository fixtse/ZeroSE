import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Admin } from '../src/adapters/inbound/admin.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import type { AccessRepository } from '../src/application/access.js';
import type { RuleRepository } from '../src/application/notification-rules.js';
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
  assert.equal((await request(admin, 'helper/123/services')).value.items[0].id, 'light.turn_on');
  assert.equal((await request(admin, 'helper/123/rules?kind=alert&offset=3')).status, 200);
  assert.deepEqual(calls[1], ['helper:123', 'alert', 3, 20]);
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

test('task provider changes require explicit confirmation and retain direct credentials', async () => {
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
  assert.equal((await request(admin, 'helper/123', 'PUT', input)).status, 400);
  assert.equal(f.profile.homeAssistant?.taskProvider, undefined);
  input.confirmTaskProviderChange = true;
  assert.equal((await request(admin, 'helper/123', 'PUT', input)).status, 200);
  assert.equal(f.profile.homeAssistant?.taskProvider, 'home_assistant');
  assert.equal(f.profile.homeAssistant?.token, 'private-ha-token');
  assert.equal(f.profile.google?.credentials.drive?.refreshToken, 'drive-refresh');
  const result = await request(admin, 'helper/123');
  assert.equal(result.value.homeAssistant.taskListEntity, 'todo.personal');
  assert(!JSON.stringify(result.value).includes('private-ha-token'));
  input.homeAssistant.taskProvider = 'google';
  input.confirmTaskProviderChange = false;
  assert.equal((await request(admin, 'helper/123', 'PUT', input)).status, 400);
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

test('HA user entity preferences can change while connection credentials remain managed by HA', async () => {
  const f = setup();
  f.profile.chatId = 'ha:' + 'a'.repeat(32);
  f.profile.homeAssistant!.voiceSatellite = 'assist_satellite.kitchen';
  const admin = new Admin(f.config, f.repository, async () => {});
  const input = {
    kind: 'user', label: 'Test', enabled: true, capabilities: ['homeAssistant'],
    homeAssistant: { locationEntity: 'person.ana', geocodedLocationEntity: 'sensor.ana_address', weatherEntity: 'weather.home' },
  };
  assert.equal((await request(admin, 'helper/' + f.profile.chatId, 'PUT', input)).status, 200);
  assert.equal(f.profile.homeAssistant?.locationEntity, 'person.ana');
  assert.equal(f.profile.homeAssistant?.geocodedLocationEntity, 'sensor.ana_address');
  assert.equal(f.profile.homeAssistant?.url, 'https://ha.example');
  assert.equal(f.profile.homeAssistant?.token, 'private-ha-token');
  assert.equal(f.profile.homeAssistant?.voiceSatellite, 'assist_satellite.kitchen');
  assert.equal((await request(admin, 'helper/' + f.profile.chatId, 'PUT', { ...input, homeAssistant: { ...input.homeAssistant, token: 'replacement' } })).status, 400);
  assert.equal((await request(admin, 'helper/' + f.profile.chatId, 'PUT', { ...input, clearHomeAssistant: true })).status, 400);
});

 test('entity catalogs filter domains before pagination', async (t) => {
  const { HomeAssistant } = await import('../src/adapters/outbound/home-assistant.js');
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { entity_id: 'sensor.first', attributes: {} },
    { entity_id: 'person.ana', attributes: { friendly_name: 'Ana' } },
    { entity_id: 'device_tracker.phone', attributes: { friendly_name: 'Phone' } },
    { entity_id: 'sensor.last', attributes: {} },
  ]));
  const config = ConfigSchema.parse({ homeAssistant: { url: 'https://ha.example', token: 'test-only' } });
  const page = await new HomeAssistant(config.homeAssistant).entityCatalog({ search: '', domains: 'person,device_tracker', offset: 1, limit: 1 }, AbortSignal.timeout(1000));
  assert.equal(page.total, 2);
  assert.equal(page.items[0].id, 'device_tracker.phone');
 });
