import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { homeAssistantUserName } from '../src/adapters/outbound/home-assistant-user-name.js';

const connection = {
  ...ConfigSchema.parse({ apiKey: 'test-key-that-is-long-enough' }).homeAssistant,
  url: 'https://ha.example',
  token: 'private-token',
};

test('a non-administrator can read their own name without listing users', async () => {
  const calls: unknown[] = [];
  const name = await homeAssistantUserName(connection, 'ken', async (_, command) => {
    calls.push(command.type);
    if (command.type === 'config/auth/list') throw new Error('Unauthorized');
    return { id: 'ken', name: 'Ken Axel', is_admin: false };
  });
  assert.equal(name, 'Ken Axel');
  assert.deepEqual(calls, ['auth/current_user']);
});

test('legacy administrator connections resolve the bound user rather than the token owner', async () => {
  const name = await homeAssistantUserName(connection, 'ken', async (_, command) =>
    command.type === 'auth/current_user'
      ? { id: 'sergio', name: 'Sergio', is_admin: true }
      : [
          { id: 'sergio', name: 'Sergio' },
          { id: 'ken', name: 'Ken Axel' },
        ],
  );
  assert.equal(name, 'Ken Axel');
});

test('a different non-administrator identity is never shown as the bound user', async () => {
  assert.equal(
    await homeAssistantUserName(connection, 'ken', async () => ({
      id: 'sergio',
      name: 'Sergio',
      is_admin: false,
    })),
    undefined,
  );
});
