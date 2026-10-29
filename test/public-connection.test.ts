import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicConnection } from '../src/application/public-connection.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { serviceConfig } from '../src/application/service-settings.js';

test('HA relay fills an empty URL once and preserves manual settings and concurrent changes', async () => {
  let revision = 1;
  let value = serviceConfig(ConfigSchema.parse({}));
  let applied = '';
  let conflict = false;
  const connection = new PublicConnection(
    {
      initialize: async () => {},
      read: async () => ({ revision, value }),
      update: async (expected, next) => {
        if (expected !== revision || conflict) return false;
        value = next;
        revision++;
        return true;
      },
    },
    (url) => {
      applied = url;
    },
    'https://admin.example',
  );
  assert.deepEqual(await connection.offer('https://ha.example/api/assistant_zero/relay/entry'), {
    configured: true,
  });
  assert.equal(applied, value.connectionUrl);
  assert.deepEqual(await connection.offer('https://other.example/api/assistant_zero/relay/entry'), {
    configured: false,
  });
  value.connectionUrl = 'https://manual.example';
  assert.deepEqual(await connection.offer('https://ha.example/api/assistant_zero/relay/entry'), {
    configured: false,
  });
  assert.equal(value.connectionUrl, 'https://manual.example');
  value.connectionUrl = '';
  conflict = true;
  applied = '';
  assert.deepEqual(await connection.offer('https://ha.example/api/assistant_zero/relay/entry'), {
    configured: false,
  });
  assert.equal(applied, '');
});
