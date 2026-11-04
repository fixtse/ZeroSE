import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { SetupAdmin } from '../src/adapters/inbound/setup-admin.js';
import type { IntegrationAccess } from '../src/application/integration-access.js';
import type { HomeAssistantPairing } from '../src/application/home-assistant-pairing.js';
import type { AccessRepository } from '../src/application/access.js';
import type { ZeroSettings } from '../src/application/zero-settings.js';

test('admin cannot discover or mutate shared Home Assistant permissions', async () => {
  const value: ZeroSettings = {
    revision: 1,
    prompt: '',
    homeAssistant: true,
  };
  const admin = new SetupAdmin(
    {} as IntegrationAccess,
    {} as HomeAssistantPairing,
    {
      read: async () => value,
      update: async () => assert.fail('Shared permissions must be managed by the HA integration'),
    },
    {} as AccessRepository,
    'https://zero.example',
  );
  for (const [method, path] of [
    ['GET', '/v1/admin/setup/services'],
    ['PUT', '/v1/admin/setup/settings'],
  ]) {
    let status: number | undefined;
    assert.equal(
      await admin.handle(
        { method, url: path } as IncomingMessage,
        path,
        async () => assert.fail('Removed endpoints must not read mutation payloads'),
        (code) => {
          status = code;
        },
      ),
      true,
    );
    assert.equal(status, 404);
  }
});
