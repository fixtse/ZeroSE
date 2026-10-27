import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantMobileRecovery } from '../src/adapters/outbound/home-assistant-mobile-recovery.js';

const userId = 'a'.repeat(32);
const config = {
  url: 'http://ha.invalid',
  token: 'test-only',
  shoppingListEntity: '',
  sensorEntities: [],
  weatherEntity: '',
  locationEntity: '',
  geocodedLocationEntity: '',
};

test('recovery uses the linked token, validates identity and reads the live scoped device list', async () => {
  const commands: Record<string, unknown>[] = [];
  let identity = userId;
  let targets: unknown = ['mobile_app_tablet', 'mobile_app_phone', 'mobile_app_phone'];
  const recovery = new HomeAssistantMobileRecovery(
    async () => ({ userId, config }),
    async (connection, command) => {
      assert.equal(connection, config);
      commands.push(command);
      if (command.type === 'auth/current_user') return { id: identity };
      if (command.type === 'assistant_zero/recovery/targets') return targets;
      return null;
    },
  );
  assert.deepEqual(await recovery.targets('profile', userId), [
    'mobile_app_phone',
    'mobile_app_tablet',
  ]);
  targets = ['mobile_app_replacement'];
  assert.deepEqual(await recovery.targets('profile', userId), targets);
  await recovery.send('profile', userId, ['mobile_app_replacement'], '12345678');
  assert.deepEqual(commands.at(-1), {
    type: 'assistant_zero/recovery/send',
    user_id: userId,
    targets,
    code: '12345678',
  });
  targets = ['notify.notify'];
  await assert.rejects(recovery.targets('profile', userId));
  targets = Array(101).fill('mobile_app_phone');
  await assert.rejects(recovery.targets('profile', userId));
  identity = 'b'.repeat(32);
  const mutations = commands.filter(
    (command) => command.type === 'assistant_zero/recovery/send',
  ).length;
  await assert.rejects(recovery.send('profile', userId, ['mobile_app_replacement'], '12345678'));
  assert.equal(
    commands.filter((command) => command.type === 'assistant_zero/recovery/send').length,
    mutations,
  );
  await assert.rejects(recovery.targets('profile', 'b'.repeat(32)));
});

test('unavailable links and uncertain sends are never retried', async () => {
  const missing = new HomeAssistantMobileRecovery(async () => undefined);
  await assert.rejects(missing.targets('profile', userId));
  let sends = 0;
  const recovery = new HomeAssistantMobileRecovery(
    async () => ({ userId, config }),
    async (_connection, command) => {
      if (command.type === 'auth/current_user') return { id: userId };
      sends++;
      throw new Error('Uncertain delivery');
    },
  );
  await assert.rejects(recovery.send('profile', userId, ['mobile_app_phone'], '12345678'));
  assert.equal(sends, 1);
});
