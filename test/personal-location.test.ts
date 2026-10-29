import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture } from './helpers.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PersonalLocation } from '../src/application/personal-location.js';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { HomeAssistantRuleScheduler } from '../src/adapters/outbound/ha-rule-scheduler.js';
import { registerHomeAssistantTools } from '../src/adapters/inbound/integration-tools.js';
import { Tools } from '../src/application/tool-registry.js';
import { toolCapability } from '../src/domain/access.js';

test('private declaration saves own person without tracker verification and enables immediate and future location alerts', async () => {
  const f = await fixture();
  let reads = 0;
  const server = createServer((req, res) => {
    reads++;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        entity_id: 'person.sergio',
        state: 'home',
        attributes: { source: 'device_tracker.unrelated', latitude: 40.4, longitude: -3.7 },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const profiles = new PostgresAccess(f.store.db, f.config.apiKey);
    await profiles.initialize(f.config);
    const homeAssistant = {
      ...f.config.homeAssistant,
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      token: 'private-test-token',
      locationEntity: 'device_tracker.previous_phone',
      geocodedLocationEntity: 'sensor.previous_address',
      sensorEntities: ['person.edson'],
    };
    await profiles.saveProfile({
      bot: 'zero',
      chatId: '1',
      kind: 'user',
      label: 'Sergio',
      enabled: true,
      owner: false,
      capabilities: ['homeAssistant'],
      homeAssistant,
    });
    const runtime = structuredClone(homeAssistant);
    const ha = new HomeAssistant(runtime);
    await assert.rejects(ha.locationEntity('person.sergio'), /not permitted/);
    const tools = new Tools({ audit: async () => {} });
    const location = new PersonalLocation(profiles, f.config.homeAssistant);
    registerHomeAssistantTools(tools, ha, runtime, undefined, (entity) =>
      location.assign('telegram:1', entity),
    );
    const result = await tools.call(
      'location_set_person',
      { entity_id: 'person.sergio' },
      { session: 'telegram:1', jobId: 'self-location', signal: AbortSignal.timeout(10000) },
    );
    assert.equal(reads, 0);
    assert(!JSON.stringify(result).includes(homeAssistant.token));
    assert.equal(runtime.locationEntity, 'person.sergio');
    assert.equal((await ha.locationEntity('person.sergio')).entity_id, 'person.sergio');
    const stored = (await new PostgresAccess(f.store.db, f.config.apiKey).profile('zero', '1'))!
      .homeAssistant!;
    assert.equal(stored.locationEntity, 'person.sergio');
    assert.equal(stored.geocodedLocationEntity, homeAssistant.geocodedLocationEntity);
    assert.deepEqual(stored.sensorEntities, ['person.edson']);
    assert.equal(stored.token, homeAssistant.token);
    const scheduler = new HomeAssistantRuleScheduler(stored);
    assert.equal(
      scheduler.permitsLocationCondition({
        source: 'distance',
        entity_id: 'person.edson',
        target_entity_id: 'person.sergio',
        operator: 'below',
        distance_m: 300,
        reset_margin_m: 100,
        hold_seconds: 0,
        max_age_seconds: 3600,
        max_accuracy_m: 200,
      }),
      true,
    );
    await assert.rejects(
      new HomeAssistant(stored).locationEntity('person.someone_else'),
      /not permitted/,
    );
    assert.equal(toolCapability('location_set_person'), 'homeAssistant');
    const grouped = new Tools({ audit: async () => {} });
    registerHomeAssistantTools(
      grouped,
      ha,
      runtime,
      { list: async () => ({ items: [] }), location: async () => ({}) },
      async () => {
        throw new Error('Must not expose in a group');
      },
    );
    assert(!grouped.definitions().some((tool) => tool.name === 'location_set_person'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('own-location declaration rejects groups, disabled profiles and missing HA permission without writing', async () => {
  const f = await fixture();
  try {
    const profiles = new PostgresAccess(f.store.db, f.config.apiKey);
    await profiles.initialize(f.config);
    const homeAssistant = {
      ...f.config.homeAssistant,
      url: 'https://ha.example',
      token: 'test-only',
    };
    const base = {
      bot: 'zero',
      chatId: '1',
      kind: 'user' as const,
      label: 'Sergio',
      enabled: true,
      owner: false,
      capabilities: ['homeAssistant' as const],
      homeAssistant,
    };
    const location = new PersonalLocation(profiles, f.config.homeAssistant);
    await profiles.saveProfile({ ...base, kind: 'group', chatId: '-1' });
    await assert.rejects(location.assign('telegram:-1', 'person.sergio'), /privado autorizado/);
    await profiles.saveProfile({ ...base, enabled: false });
    await assert.rejects(location.assign('telegram:1', 'person.sergio'), /privado autorizado/);
    await profiles.saveProfile({ ...base, capabilities: [] });
    await assert.rejects(location.assign('telegram:1', 'person.sergio'), /privado autorizado/);
    await assert.rejects(location.assign('telegram:1', 'sensor.anything'), /person válida/);
    assert.equal((await profiles.profile('zero', '1'))?.homeAssistant?.locationEntity, '');
  } finally {
    await f.close();
  }
});

test('private distance tools use the already configured profile person without calling the declaration tool', async () => {
  const { ConfigSchema } = await import('../src/adapters/outbound/config-schema.js');
  const config = ConfigSchema.parse({
    homeAssistant: {
      token: 'test-only',
      locationEntity: 'person.sergio',
      sensorEntities: ['person.edson'],
    },
  }).homeAssistant;
  const calls: string[][] = [];
  let declarations = 0;
  const tools = new Tools({ audit: async () => {} });
  registerHomeAssistantTools(
    tools,
    {
      location: async () => ({ coordinates: { latitude: 40.4, longitude: -3.7 } }),
      distance: async (a: string, b: string) => {
        calls.push([a, b]);
        return { distance_m: 200 };
      },
    } as any,
    config,
    undefined,
    async () => {
      declarations++;
    },
  );
  const context = {
    session: 'telegram:1',
    jobId: 'existing-profile-location',
    signal: AbortSignal.timeout(10000),
  };
  await tools.call('ha_distance', { person_a: 'person.edson', person_b: 'self' }, context);
  assert.deepEqual(calls, [['person.edson', 'person.sergio']]);
  const location = await tools.call('location_get', {}, context);
  assert(JSON.stringify(location).includes('person.sergio'));
  assert.equal(declarations, 0);
  assert.equal(config.locationEntity, 'person.sergio');
});
