import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicConnection, hasPublicServerUrl } from '../src/application/public-connection.js';
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

test('relay preserves an existing public server URL and still supports local-only installations', async () => {
  for (const serverUrl of [
    'https://existing.example',
    'http://existing.example:8788',
    'http://127.0.0.1:8788',
    'http://192.168.1.2:8788',
    '',
  ]) {
    let writes = 0;
    const connection = new PublicConnection(
      {
        initialize: async () => {},
        read: async () => ({ revision: 1, value: serviceConfig(ConfigSchema.parse({})) }),
        update: async () => {
          writes++;
          return true;
        },
      },
      () => {},
      'http://localhost:8788',
      serverUrl,
    );
    const publicServer = serverUrl.includes('existing.example');
    assert.deepEqual(await connection.offer('https://ha.example/api/assistant_zero/relay/entry'), {
      configured: !publicServer,
    });
    assert.equal(writes, publicServer ? 0 : 1);
  }
  for (const url of [
    'invalid',
    'http://localhost',
    'http://[::1]',
    'http://172.18.0.2',
    'http://zero.local',
    'https://user:secret@example.com',
  ])
    assert.equal(hasPublicServerUrl(url), false);
});
