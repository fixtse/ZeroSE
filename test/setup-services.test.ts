import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { SetupAdmin } from '../src/adapters/inbound/setup-admin.js';
import type { IntegrationAccess } from '../src/application/integration-access.js';
import type { HomeAssistantPairing } from '../src/application/home-assistant-pairing.js';
import type { AccessRepository } from '../src/application/access.js';
import type { ZeroSettings } from '../src/application/zero-settings.js';

test('shared service discovery is scoped, paginated and detects Frigate by domain', async () => {
  let value: ZeroSettings = {
    revision: 1,
    prompt: '',
    homeAssistant: true,
    assist: false,
    frigate: false,
    services: [],
  };
  let available = false;
  let failing = false;
  const queries: unknown[] = [];
  const admin = new SetupAdmin(
    {} as IntegrationAccess,
    {} as HomeAssistantPairing,
    {
      read: async () => value,
      update: async (input) => {
        value = input;
        return value;
      },
    },
    {} as AccessRepository,
    'https://zero.example',
    undefined,
    async () => true,
    async () => ({
      entities: async () => ({ items: [], total: 0 }),
      services: async (query) => {
        queries.push(query);
        if (failing) throw new Error('offline');
        if (query.search === 'frigate.')
          return {
            items: available
              ? [{ id: 'frigate.restart', name: 'Restart' }]
              : [{ id: 'script.frigate.restart', name: 'Unrelated' }],
            total: 1,
          };
        return { items: [{ id: 'light.turn_on', name: 'Turn on' }], total: 42 };
      },
    }),
  );
  async function request(method: string, url: string, body?: unknown) {
    let result: { status: number; body: any } | undefined;
    assert.equal(
      await admin.handle(
        { method, url } as IncomingMessage,
        url.split('?')[0],
        async () => body,
        (status, body) => {
          result = { status, body };
        },
      ),
      true,
    );
    return result!;
  }
  const page = await request('GET', '/v1/admin/setup/services?search=light&offset=20&limit=10');
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 42);
  assert.equal(page.body.frigateAvailable, false);
  assert.deepEqual(queries[0], { search: 'light', offset: 20, limit: 10 });
  const denied = await request('PUT', '/v1/admin/setup/settings', { ...value, frigate: true });
  assert.equal(denied.status, 400);
  assert.equal(value.frigate, false);
  available = true;
  assert.equal((await request('GET', '/v1/admin/setup/services')).body.frigateAvailable, true);
  assert.equal(
    (await request('PUT', '/v1/admin/setup/settings', { ...value, frigate: true })).status,
    200,
  );
  failing = true;
  assert.equal((await request('GET', '/v1/admin/setup/services')).status, 502);
});
