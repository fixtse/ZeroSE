import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionProfileWeather } from '../src/application/profile-weather.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import type { AccessProfile } from '../src/domain/access.js';

const config = ConfigSchema.parse({});
function profile(chatId: string, extra: Partial<AccessProfile> = {}): AccessProfile {
  return {
    bot: 'zero',
    chatId,
    kind: 'user',
    label: chatId,
    enabled: true,
    owner: false,
    capabilities: ['homeAssistant'],
    homeAssistant: { ...config.homeAssistant, url: 'https://ha.example', token: 'test-token' },
    notifications: {
      eventReminders: false,
      reset: { enabled: false, time: '04:00' },
      morning: { mode: 'off', time: '08:30', entity: '', state: 'off' },
      weather: { mode: 'updates', routineIntervalHours: 6 },
    },
    ...extra,
  };
}
test('startup provisions opted-in non-owners across pages without a user-created alert', async () => {
  const profiles = [
    ...Array.from({ length: 100 }, (_, i) => profile(String(i), { enabled: false })),
    profile('owner', { owner: true }),
    profile('non-owner'),
    profile('off', { notifications: undefined }),
    profile('ha:voice'),
    profile('no-ha', { capabilities: [] }),
  ];
  const calls: unknown[] = [];
  await provisionProfileWeather(
    {
      async profiles(_search, offset, limit) {
        assert.equal(limit, 100);
        return { items: profiles.slice(offset, offset + limit), total: profiles.length };
      },
    },
    config,
    {
      async ensureProfileWeather(session, sleep) {
        calls.push([session, sleep]);
        return undefined as never;
      },
    },
    () => assert.fail('unexpected setup failure'),
  );
  assert.deepEqual(calls, [
    ['telegram:owner', 'input_boolean.dormir'],
    ['telegram:non-owner', null],
  ]);
});

test('a failed subscription is not retried and does not block another profile', async () => {
  const calls: string[] = [],
    failures: string[] = [];
  await provisionProfileWeather(
    {
      async profiles() {
        return { items: [profile('one'), profile('two')], total: 2 };
      },
    },
    config,
    {
      async ensureProfileWeather(session) {
        calls.push(session);
        if (session === 'telegram:one') throw new Error('uncertain');
        return undefined as never;
      },
    },
    (profile) => failures.push(profile.chatId),
  );
  assert.deepEqual(calls, ['telegram:one', 'telegram:two']);
  assert.deepEqual(failures, ['one']);
});
