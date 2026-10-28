import { PostgresAssistantDefinitions } from '../src/adapters/outbound/postgres-assistant-definitions.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fixture } from './helpers.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresZeroSettings } from '../src/adapters/outbound/postgres-zero-settings.js';
import {
  PostgresIntegrationAccess,
  credentialCrypto,
} from '../src/adapters/outbound/postgres-integration-access.js';
import { PostgresPairing } from '../src/adapters/outbound/postgres-pairing.js';
import { IntegrationAccess } from '../src/application/integration-access.js';
import { HomeAssistantPairing } from '../src/application/home-assistant-pairing.js';
import { Access } from '../src/application/access.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { SetupAdmin } from '../src/adapters/inbound/setup-admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';

async function setup() {
  const f = await fixture();
  f.config.telegram.allowedUsers = ['1'];
  const profiles = new PostgresAccess(f.store.db, f.config.apiKey);
  await profiles.initialize(f.config);
  await new PostgresAssistantDefinitions(f.store.db).create({
    id: 'helper',
    name: 'Helper',
    prompt: 'Helper identity',
    revision: 1,
    memoryPolicy: 'automatic',
    builtin: false,
  });
  const settings = new PostgresZeroSettings(f.store.db);
  await settings.initialize('Original identity');
  const repository = new PostgresIntegrationAccess(f.store.db);
  await repository.initialize();
  let now = Date.now();
  const tokens = new IntegrationAccess(repository, credentialCrypto, () => new Date(now));
  const pairing = new HomeAssistantPairing(
    profiles,
    new PostgresPairing(f.store.db, profiles, settings),
    credentialCrypto,
    f.config.homeAssistant,
    'https://zero.example',
    () => now,
  );
  const input = {
    secret: 'a'.repeat(64),
    state: 'b'.repeat(64),
    homeAssistantUrl: 'https://ha.example',
    flowId: 'setup-flow',
    userId: 'c'.repeat(32),
  };
  return {
    ...f,
    profiles,
    settings,
    repository,
    tokens,
    pairing,
    input,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('HA pairing stores credentials encrypted, binds private user, and consumes exchange once', async () => {
  const f = await setup();
  try {
    const request = f.pairing.begin(f.input);
    assert.equal(new URL(request.approvalUrl).origin, 'https://zero.example');
    assert.equal(JSON.stringify(f.pairing.details(request.id)).includes(f.input.secret), false);
    await assert.rejects(f.pairing.exchange(request.id, f.input.secret, 'ha-private-token'));
    const before = await f.profiles.profile('zero', '1');
    const approval = await f.pairing.approve(request.id, '1');
    assert.equal(
      approval.redirectUrl,
      'https://ha.example/api/assistant_zero/pairing/setup-flow?state=' + f.input.state,
    );
    await assert.rejects(f.pairing.exchange(request.id, 'd'.repeat(64), 'ha-private-token'));
    const result = await f.pairing.exchange(request.id, f.input.secret, 'ha-private-token');
    const after = await f.profiles.profile('zero', '1');
    assert.equal(after?.homeAssistant?.token, 'ha-private-token');
    assert.equal(after?.homeAssistant?.url, 'https://ha.example');
    assert.deepEqual(after?.capabilities, [...new Set([...before!.capabilities, 'homeAssistant'])]);
    assert.equal((await f.settings.read()).homeAssistantUsers?.[f.input.userId], '1');
    for (const scope of ['voice', 'rules', 'settings'] as const)
      assert.equal(await f.tokens.authorize('Bearer ' + result.token, scope), true);
    const raw = JSON.stringify(
      (await f.store.pool.query('SELECT * FROM integration_credentials')).rows,
    );
    assert.equal(raw.includes(result.token), false);
    assert.equal(
      JSON.stringify(
        (await f.store.pool.query('SELECT credentials FROM access_profiles')).rows,
      ).includes('ha-private-token'),
      false,
    );
    assert.equal(JSON.stringify(await f.tokens.list(0, 20)).includes(result.token), false);
    await assert.rejects(f.pairing.exchange(request.id, f.input.secret, 'ha-private-token'));
    await f.tokens.revoke(result.credential_id);
    assert.equal(await f.tokens.authorize('Bearer ' + result.token, 'voice'), false);
  } finally {
    await f.close();
  }
});

test('pairing rejects expired requests, invalid origins and disabled profiles', async () => {
  const f = await setup();
  try {
    assert.throws(() =>
      f.pairing.begin({ ...f.input, homeAssistantUrl: 'https://user:secret@ha.example' }),
    );
    assert.throws(() =>
      f.pairing.begin({ ...f.input, homeAssistantUrl: 'https://ha.example/other' }),
    );
    const request = f.pairing.begin(f.input);
    const profile = (await f.profiles.profile('zero', '1'))!;
    await f.profiles.saveProfile({ ...profile, enabled: false });
    await assert.rejects(f.pairing.approve(request.id, '1'));
    f.advance(600001);
    assert.throws(() => f.pairing.details(request.id));
    await assert.rejects(f.pairing.approve(request.id, '1'));
    const issued = await f.tokens.issue('Expiry', 1);
    f.advance(86400001);
    assert.equal(await f.tokens.authorize('Bearer ' + issued.token, 'settings'), false);
  } finally {
    await f.close();
  }
});

test('pairing transaction rolls back profile and credential on a binding conflict', async () => {
  const f = await setup();
  try {
    const conflicting = new PostgresZeroSettings(f.store.db);
    conflicting.update = async () => undefined;
    const pairing = new HomeAssistantPairing(
      f.profiles,
      new PostgresPairing(f.store.db, f.profiles, conflicting),
      credentialCrypto,
      f.config.homeAssistant,
      'https://zero.example',
    );
    const request = pairing.begin(f.input);
    await pairing.approve(request.id, '1');
    await assert.rejects(pairing.exchange(request.id, f.input.secret, 'ha-private-token'));
    assert.equal((await f.profiles.profile('zero', '1'))?.homeAssistant, undefined);
    assert.equal((await f.tokens.list(0, 20)).total, 0);
    assert.equal((await f.settings.read()).revision, 1);
    await assert.rejects(pairing.exchange(request.id, f.input.secret, 'ha-private-token'));
  } finally {
    await f.close();
  }
});

test('HTTP requires administrator access for approval and keeps issued tokens out of admin/chat endpoints', async () => {
  const f = await setup();
  const access = new Access(f.profiles, f.store);
  const server = createHttpServer(
    f.config,
    f.store,
    undefined,
    { access, admin: new Admin(f.config, f.profiles, async () => {}) },
    undefined,
    undefined,
    undefined,
    f.settings,
    f.tokens,
    f.pairing,
    new SetupAdmin(f.tokens, f.pairing, f.settings, f.profiles, 'https://zero.example'),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, token = '') =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const started = await post('/v1/pairing/home-assistant', f.input);
    assert.equal(started.status, 201);
    const request = (await started.json()) as { id: string };
    const approval = '/v1/admin/setup/pairings/' + request.id + '/approve';
    const targetsPath = '/v1/admin/setup/pairings/' + request.id + '/profiles?limit=1';
    assert.equal((await fetch(base + targetsPath)).status, 401);
    const targets = await fetch(base + targetsPath, {
      headers: { Authorization: 'Bearer ' + f.config.apiKey },
    });
    assert.equal(targets.status, 200);
    assert.equal(((await targets.json()) as any).items[0].chatId, '1');
    assert.equal((await post(approval, { chatId: '1' })).status, 401);
    assert.equal((await post(approval, { chatId: '1' }, f.config.apiKey)).status, 200);
    const exchanged = await post('/v1/pairing/home-assistant/exchange', {
      id: request.id,
      secret: f.input.secret,
      homeAssistantToken: 'home-assistant-private-token',
    });
    assert.equal(exchanged.status, 200);
    const credential = (await exchanged.json()) as { token: string };
    for (const path of [
      '/v1/admin/profiles',
      '/v1/admin/setup/tokens',
      '/v1/admin/setup/settings',
      '/v1/jobs/anything',
    ])
      assert.equal(
        (await fetch(base + path, { headers: { Authorization: 'Bearer ' + credential.token } }))
          .status,
        401,
      );
    assert.equal(
      (await post('/v1/chat', { session: 'x', text: 'forbidden' }, credential.token)).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + '/v1/integrations/home-assistant/settings', {
          headers: { Authorization: 'Bearer ' + credential.token },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post('/v1/pairing/home-assistant/exchange', {
          id: request.id,
          secret: f.input.secret,
          homeAssistantToken: 'home-assistant-private-token',
        })
      ).status,
      400,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('pairing a group updates only its HA connection and preserves owner and private voice bindings', async () => {
  const f = await setup();
  try {
    await f.profiles.discover('zero', '-42', 'Second house', 'group');
    const group = (await f.profiles.profile('zero', '-42'))!;
    await f.profiles.saveProfile({
      ...group,
      enabled: true,
      capabilities: ['homeAssistant'],
      assistantId: 'helper',
    });
    const owner = await f.profiles.profile('zero', '1');
    const settings = await f.settings.read();
    const request = f.pairing.begin({ ...f.input, homeAssistantUrl: 'https://second-ha.example' });
    await f.pairing.approve(request.id, '-42');
    const result = await f.pairing.exchange(request.id, f.input.secret, 'second-ha-token');
    assert.deepEqual(await f.profiles.profile('zero', '1'), owner);
    assert.deepEqual(await f.settings.read(), settings);
    const paired = (await f.profiles.profile('zero', '-42'))!;
    assert.equal(paired.homeAssistant?.url, 'https://second-ha.example');
    assert.equal(paired.homeAssistant?.token, 'second-ha-token');
    assert.equal(paired.assistantId, 'helper');
    assert.deepEqual(paired.capabilities, ['homeAssistant']);
    assert.deepEqual(paired.homeAssistant?.sensorEntities, []);
    assert.equal(await f.tokens.authorize('Bearer ' + result.token, 'rules'), true);
    await assert.rejects(f.pairing.exchange(request.id, f.input.secret, 'second-ha-token'));
  } finally {
    await f.close();
  }
});

test('pairing private users of another assistant preserves assignment and routes HA voice to their existing session', async () => {
  const f = await setup();
  try {
    await f.profiles.discover('helper', '77', 'Other assistant user', 'user');
    const profile = (await f.profiles.profile('helper', '77'))!;
    await f.profiles.saveProfile({ ...profile, enabled: true, assistantId: 'helper' });
    const owner = await f.profiles.profile('zero', '1');
    const request = f.pairing.begin(f.input);
    await f.pairing.approve(request.id, '77', 'helper');
    await f.pairing.exchange(request.id, f.input.secret, 'helper-ha-token');
    assert.deepEqual(await f.profiles.profile('zero', '1'), owner);
    const paired = (await f.profiles.profile('helper', '77'))!;
    assert.equal(paired.assistantId, 'helper');
    assert.equal(paired.bot, 'helper');
    assert.deepEqual(paired.capabilities, [...profile.capabilities, 'homeAssistant']);
    assert.equal(paired.homeAssistant?.token, 'helper-ha-token');
    assert.equal((await f.settings.read()).homeAssistantUsers?.[f.input.userId], 'helper:77');
    const { voiceUserSession } = await import('../src/application/voice-bridge.js');
    const access = new Access(f.profiles, f.store);
    assert.equal(
      await voiceUserSession(f.input.userId, f.settings, access, {
        isEnabled: async (bot) => bot === 'helper',
      }),
      'helper:77',
    );
    assert.equal(
      await voiceUserSession(f.input.userId, f.settings, access, { isEnabled: async () => false }),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test('pairing targets are filtered before pagination, searchable across assistants, and contain no credentials', async () => {
  const f = await setup();
  try {
    for (let i = 10; i < 35; i++) {
      await f.profiles.discover('zero', String(i), 'Person ' + i, 'user');
      const profile = (await f.profiles.profile('zero', String(i)))!;
      await f.profiles.saveProfile({ ...profile, enabled: true });
    }
    await f.profiles.discover('helper', '-42', 'Remote group', 'group');
    const group = (await f.profiles.profile('helper', '-42'))!;
    await f.profiles.saveProfile({ ...group, enabled: true });
    await f.profiles.discover('zero', '99', 'Disabled user', 'user');
    const first = await f.profiles.pairingProfiles('', 0, 20);
    assert.equal(first.total, 27);
    assert.equal(first.items.length, 20);
    assert.equal((await f.profiles.pairingProfiles('', 20, 20)).items.length, 7);
    const search = await f.profiles.pairingProfiles('Remote', 0, 20);
    assert.deepEqual(search.items, [
      { bot: 'helper', chatId: '-42', label: 'Remote group', kind: 'group' },
    ]);
    assert.equal((await f.profiles.pairingProfiles('Disabled', 0, 20)).total, 0);
    assert.ok(!JSON.stringify(first).includes('token'));
  } finally {
    await f.close();
  }
});
