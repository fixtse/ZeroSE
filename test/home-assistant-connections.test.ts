import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantConnections } from '../src/application/home-assistant-connections.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import type { AccessProfile } from '../src/domain/access.js';

test('connected instances come from enabled Zero bindings and are deduplicated by URL', async () => {
  const connection = ConfigSchema.parse({}).homeAssistant;
  const profiles: Record<string, AccessProfile> = Object.fromEntries(
    ['1', '2', '3', '4'].map((chatId) => [
      chatId,
      {
        bot: 'zero',
        chatId,
        kind: 'user',
        label: 'House ' + chatId,
        enabled: chatId !== '4',
        capabilities: ['homeAssistant'],
        owner: false,
        homeAssistant: {
          ...connection,
          url: chatId === '3' ? 'https://other.example' : 'https://ha.example',
          token: 'private-token',
        },
      },
    ]),
  );
  profiles['1'].pairedHomeAssistant = {
    ...connection,
    url: 'https://ha.example',
    token: 'paired-private-token',
  };
  profiles['1'].homeAssistant = {
    ...connection,
    url: 'https://manual.example',
    token: 'manual-private-token',
  };
  const catalog = new HomeAssistantConnections(
    {
      async read() {
        return {
          revision: 1,
          prompt: '',
          homeAssistant: true,
          assist: true,
          frigate: false,
          services: [],
          homeAssistantUsers: { a: '1', b: '2', c: '3', d: '4', e: '-42' },
        };
      },
      async update() {
        throw new Error('Read only');
      },
    },
    {
      async profile(bot, id) {
        return bot === 'zero' ? profiles[id] : undefined;
      },
    },
  );
  const result = await catalog.list();
  assert.deepEqual(
    result.map(({ id, connection }) => ({ id, url: connection.url })),
    [
      { id: 'telegram:1', url: 'https://ha.example' },
      { id: 'telegram:3', url: 'https://other.example' },
    ],
  );
});
