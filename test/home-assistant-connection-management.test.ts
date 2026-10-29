import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { fixture } from './helpers.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresZeroSettings } from '../src/adapters/outbound/postgres-zero-settings.js';
import { PostgresHomeAssistantConnections } from '../src/adapters/outbound/postgres-home-assistant-connections.js';
import { HomeAssistantConnections } from '../src/application/home-assistant-connections.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import type { AccessProfile } from '../src/domain/access.js';

async function setup() {
  const f = await fixture();
  const profiles = new PostgresAccess(f.store.db, f.config.apiKey);
  await profiles.initialize(f.config);
  const ha = {
    ...f.config.homeAssistant,
    url: 'https://ha.example',
    token: 'long-lived-private-token-original',
  };
  const other = { ...ha, url: 'https://cabin.example', token: 'long-lived-cabin-private-token' };
  const base: AccessProfile = {
    bot: 'zero',
    chatId: '1',
    label: 'Ana',
    owner: false,
    kind: 'user',
    enabled: true,
    capabilities: ['homeAssistant'],
    pairedHomeAssistant: ha,
    homeAssistant: ha,
  };
  await profiles.saveProfile(base);
  await profiles.saveProfile({
    ...base,
    chatId: '2',
    label: 'Cabin owner',
    homeAssistant: other,
    pairedHomeAssistant: other,
  });
  await profiles.saveProfile({
    ...base,
    chatId: '-3',
    label: 'Family',
    kind: 'group',
    pairedHomeAssistant: undefined,
    homeAssistant: {
      ...ha,
      weatherEntity: 'weather.family',
      connections: [
        { id: 'telegram:1', name: 'Ana', url: ha.url },
        { id: 'telegram:2', name: 'Cabin owner', url: other.url },
      ],
      activeConnectionId: 'telegram:1',
    },
  });
  await profiles.saveProfile({ ...base, chatId: 'ha:' + 'a'.repeat(32), label: 'Voice user' });
  const settings = new PostgresZeroSettings(f.store.db);
  await settings.initialize('Zero');
  await settings.update({
    ...(await settings.read()),
    homeAssistantUsers: { ['a'.repeat(32)]: '1' },
  });
  const manager = new HomeAssistantConnections(
    settings,
    profiles,
    new PostgresHomeAssistantConnections(f.store.db, profiles),
  );
  const admin = new Admin(f.config, profiles, async () => {}).withHomeAssistantConnections(manager);
  async function request(method: string, body?: unknown) {
    let status = 0;
    let value: any;
    const url = '/v1/admin/home-assistant/connections';
    await admin.handle(
      { method, url } as IncomingMessage,
      url,
      async () => body,
      (code, result) => {
        status = code;
        value = result;
      },
    );
    return { status, value };
  }
  return { ...f, profiles, settings, manager, request, ha };
}

test('HA manager edits server names and long-lived tokens across profiles, with masked responses and stale-edit protection', async () => {
  const f = await setup();
  try {
    const initial = (await f.request('GET')).value;
    const server = initial.items.find((item: any) => item.id === 'telegram:1');
    assert.equal(server.tokenHint, 'long••••••••inal');
    assert(!JSON.stringify(initial).includes(f.ha.token));
    const body = {
      id: server.id,
      version: server.version,
      name: 'Casa',
      token: 'replacement-private-long-lived-token',
    };
    assert.equal((await f.request('PUT', body)).status, 200);
    assert.equal((await f.profiles.profile('zero', '1'))?.label, 'Ana');
    assert.equal((await f.profiles.profile('zero', '1'))?.pairedHomeAssistant?.name, 'Casa');
    const group = (await f.profiles.profile('zero', '-3'))!;
    assert.equal(group.homeAssistant?.token, body.token);
    assert.equal(group.homeAssistant?.weatherEntity, 'weather.family');
    assert.equal(group.homeAssistant?.connections?.[0].name, 'Casa');
    assert.equal(
      (await f.profiles.profile('zero', 'ha:' + 'a'.repeat(32)))?.pairedHomeAssistant?.token,
      body.token,
    );
    assert.equal((await f.request('PUT', body)).status, 409);
    const current = (await f.request('GET')).value.items.find((item: any) => item.id === server.id);
    assert.equal(current.name, 'Casa');
    assert(!JSON.stringify(current).includes(body.token));
    assert.equal(
      (
        await f.request('PUT', {
          id: current.id,
          version: current.version,
          name: 'Casa nueva',
          token: '',
        })
      ).status,
      200,
    );
    assert.equal((await f.profiles.profile('zero', '1'))?.homeAssistant?.token, body.token);
  } finally {
    await f.close();
  }
});

test('HA deletion removes source credentials and saved selections permanently, retaining a different selected server', async () => {
  const f = await setup();
  try {
    const server = (await f.manager.list()).find((item) => item.id === 'telegram:1')!;
    assert.equal(
      (await f.request('DELETE', { id: server.id, version: server.version })).status,
      200,
    );
    const reloaded = new PostgresAccess(f.store.db, f.config.apiKey);
    for (const id of ['1', 'ha:' + 'a'.repeat(32)]) {
      const profile = (await reloaded.profile('zero', id))!;
      assert.equal(profile.pairedHomeAssistant, undefined);
      assert.equal(profile.homeAssistant?.token, '');
      await reloaded.saveProfile({ ...profile, label: 'Renamed after deletion' });
      assert.equal((await reloaded.profile('zero', id))?.homeAssistant?.token, '');
    }
    const group = (await reloaded.profile('zero', '-3'))!;
    assert.equal(group.homeAssistant?.activeConnectionId, 'telegram:2');
    assert.equal(group.homeAssistant?.token, 'long-lived-cabin-private-token');
    assert.deepEqual(
      group.homeAssistant?.connections?.map((item) => item.id),
      ['telegram:2'],
    );
    assert.equal(group.homeAssistant?.weatherEntity, 'weather.family');
    assert((await f.manager.list()).every((item) => item.connection.url !== f.ha.url));
    assert.equal(
      (await f.request('DELETE', { id: server.id, version: server.version })).status,
      409,
    );
  } finally {
    await f.close();
  }
});
