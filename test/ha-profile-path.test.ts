import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture } from './helpers.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { Access } from '../src/application/access.js';
import { UserContext } from '../src/application/user-context.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';

test('HA-only profile URLs encoded by the editor support read, save and context without changing credentials', async () => {
  const f = await fixture();
  const profiles = new PostgresAccess(f.store.db, f.config.apiKey);
  await profiles.initialize(f.config);
  const userId = 'a'.repeat(32);
  const connection = {
    ...f.config.homeAssistant,
    url: 'https://ha.example',
    token: 'private-ha-test-token',
  };
  await profiles.ensureHomeAssistantUser(userId, 'Ana HA', connection);
  const admin = new Admin(
    f.config,
    profiles,
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new UserContext(profiles),
  );
  const server = createHttpServer(f.config, f.store, undefined, {
    access: new Access(profiles, f.store),
    admin,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  const path = '/v1/admin/profiles/zero/' + encodeURIComponent('ha:' + userId);
  const headers = {
    Authorization: 'Bearer ' + f.config.apiKey,
    'Content-Type': 'application/json',
  };
  try {
    assert.equal((await fetch(base + path)).status, 401);
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200);
    const profile = (await response.json()) as any;
    assert.equal(profile.chatId, 'ha:' + userId);
    assert.equal(profile.source, 'home_assistant');
    assert(!JSON.stringify(profile).includes(connection.token));
    const saved = await fetch(base + path, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        kind: 'user',
        label: 'Ana updated',
        enabled: true,
        capabilities: profile.capabilities,
        timezone: 'Europe/Madrid',
        memoryMode: 'simple',
      }),
    });
    assert.equal(saved.status, 200);
    const context = await fetch(base + path + '/context', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ memory: 'Context for Ana', revision: 0 }),
    });
    assert.equal(context.status, 200);
    const raw = await fetch(base + '/v1/admin/profiles/zero/ha:' + userId, { headers });
    assert.equal(raw.status, 200);
    const value = (await raw.json()) as any;
    assert.equal(value.label, 'Ana updated');
    assert.equal(value.context, 'Context for Ana');
    assert.equal(
      (await profiles.profile('zero', 'ha:' + userId))?.homeAssistant?.token,
      connection.token,
    );
    assert.equal((await fetch(base + path.replace('%3A', '%3a'), { headers })).status, 200);
    assert.equal((await fetch(base + path.replace('%3A', '%253A'), { headers })).status, 404);
    assert.equal((await fetch(base + path.replace('%3A', '%2F'), { headers })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
