import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Script } from 'node:vm';
import { Admin } from '../src/adapters/inbound/admin.js';
import { adminPage } from '../src/adapters/inbound/admin-page.js';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import type { AccessRepository } from '../src/application/access.js';
import type { RuleRepository } from '../src/application/notification-rules.js';
import type { AccessProfile } from '../src/domain/access.js';

function setup() {
  const config = ConfigSchema.parse({});
  const profile: AccessProfile = {
    bot: 'salem',
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
    (await request(admin, 'salem/123/entities?search=test&limit=5&offset=2')).status,
    200,
  );
  assert.deepEqual(calls[0], { search: 'test', limit: 5, offset: 2 });
  assert.equal((await request(admin, 'salem/123/services')).value.items[0].id, 'light.turn_on');
  assert.equal((await request(admin, 'salem/123/rules?kind=alert&offset=3')).status, 200);
  assert.deepEqual(calls[1], ['salem:123', 'alert', 3, 20]);
  assert.equal((await request(admin, 'zero/123/rules')).status, 404);
  await assert.rejects(request(admin, 'salem/123/entities?limit=51'));
  f.profile.capabilities = [];
  assert.equal((await request(admin, 'salem/123/entities')).status, 400);
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
  assert.equal((await request(admin, 'salem/123', 'PUT', input)).status, 200);
  assert.equal(f.profile.google?.credentials.calendar?.clientId, 'updated-id');
  assert.equal(f.profile.google?.credentials.calendar?.clientSecret, 'private-client');
  assert.equal(f.profile.google?.credentials.calendar?.refreshToken, 'private-refresh');
  assert.equal(f.profile.google?.credentials.drive?.refreshToken, 'drive-refresh');
  const result = await request(admin, 'salem/123');
  assert.equal(result.value.google.credentials.calendar.configured, true);
  assert(!JSON.stringify(result.value).includes('private-'));
  assert(!JSON.stringify(result.value).includes('drive-secret'));
  assert(!JSON.stringify(result.value).includes('drive-refresh'));
});

test('embedded admin script parses with the alert and catalog controls', () => {
  new Script(adminPage.split('<script>')[1].split('</script>')[0]);
  for (const id of ['rulesList', 'ruleKind', 'haCatalogList', 'serviceCredentials'])
    assert(adminPage.includes('id="' + id + '"'));
});
