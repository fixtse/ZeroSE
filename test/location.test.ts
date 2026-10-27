import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { registerHomeAssistantTools } from '../src/adapters/inbound/integration-tools.js';
import { Tools } from '../src/application/tool-registry.js';
import { toolCapability } from '../src/domain/access.js';

test('location tool reports presence, zones and independent GPS/address observations using only GETs', async () => {
  let state = 'home';
  let failTracker = false;
  const requests: string[] = [];
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 86400_000).toISOString();
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer test-only');
    requests.push(req.url!);
    const tracker = req.url === '/api/states/device_tracker.galaxy_s26';
    res.setHeader('Content-Type', 'application/json');
    if (tracker && failTracker) {
      res.writeHead(503).end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        state: tracker ? state : 'Example Street, Madrid',
        last_changed: old,
        last_updated: old,
        last_reported: tracker ? now : old,
        attributes: tracker
          ? { latitude: 40.4, longitude: -3.7, gps_accuracy: 12, private_attribute: 'omit' }
          : { location: [40.5, -3.8] },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = ConfigSchema.parse({
    homeAssistant: {
      token: 'test-only',
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      sensorEntities: ['sensor.temperature'],
      locationEntity: 'device_tracker.galaxy_s26',
      geocodedLocationEntity: 'sensor.galaxy_s26_geocoded_location',
    },
  }).homeAssistant;
  const ha = new HomeAssistant(config);
  const tools = new Tools({ audit: async () => {} });
  registerHomeAssistantTools(tools, ha, config);
  const read = () =>
    tools.call(
      'location_get',
      {},
      {
        session: 'test',
        jobId: 'location',
        signal: new AbortController().signal,
      },
    ) as ReturnType<HomeAssistant['location']>;
  try {
    const home = await read();
    assert.equal(home.presence, 'home');
    assert.equal(home.zone, 'home');
    assert.deepEqual(home.tracker?.coordinates, {
      latitude: 40.4,
      longitude: -3.7,
      accuracy_m: 12,
    });
    assert((home.tracker?.age_seconds ?? Infinity) < 10);
    assert((home.geocoded?.age_seconds ?? 0) >= 86400);
    assert.equal(home.geocoded?.state, 'Example Street, Madrid');
    assert.deepEqual(home.geocoded?.coordinates, { latitude: 40.5, longitude: -3.8 });
    assert(!JSON.stringify(home).includes('private_attribute'));
    state = 'Gym';
    assert.equal((await read()).zone, 'Gym');
    assert.equal((await read()).presence, 'away');
    state = 'not_home';
    const away = await read();
    assert.equal(away.presence, 'away');
    assert.equal(away.zone, null);
    for (const invalid of ['unknown', 'unavailable', '']) {
      state = invalid;
      const unavailable = await read();
      assert.equal(unavailable.presence, 'unknown');
      assert.equal(unavailable.zone, null);
      assert.equal(unavailable.tracker?.coordinates, null);
      assert.equal(unavailable.geocoded?.available, true);
    }
    failTracker = true;
    const partial = await read();
    assert.equal(partial.presence, 'unknown');
    assert.equal(partial.tracker?.available, false);
    assert.equal(partial.geocoded?.available, true);
    await assert.rejects(() => ha.sensor('sensor.galaxy_s26_geocoded_location'), /not permitted/);
    await assert.rejects(() => ha.sensor('device_tracker.galaxy_s26'), /not permitted/);
    assert(
      requests.every((path) =>
        /^\/api\/states\/(device_tracker.galaxy_s26|sensor.galaxy_s26_geocoded_location)$/.test(
          path,
        ),
      ),
    );
    config.locationEntity = '';
    config.geocodedLocationEntity = '';
    const disabled = new Tools({ audit: async () => {} });
    registerHomeAssistantTools(disabled, ha, config);
    assert(!disabled.definitions().some((tool) => tool.name === 'location_get'));
    await assert.rejects(() => ha.location(), /not configured/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('location configuration only accepts the intended entity domains', () => {
  assert.throws(() => ConfigSchema.parse({ homeAssistant: { locationEntity: 'switch.light' } }));
  assert.throws(() =>
    ConfigSchema.parse({ homeAssistant: { geocodedLocationEntity: '../config' } }),
  );
  assert.equal(
    ConfigSchema.parse({ homeAssistant: { locationEntity: 'person.sergio' } }).homeAssistant
      .locationEntity,
    'person.sergio',
  );
});

test('location discovery is scoped, bounded and excludes private attributes', async () => {
  const states = [
    {
      entity_id: 'person.a',
      state: 'home',
      attributes: { friendly_name: 'Ana', latitude: 0, longitude: 0, private: 'omit' },
    },
    { entity_id: 'person.private', state: 'home', attributes: {} },
    { entity_id: 'zone.office', state: '0', attributes: { radius: 100 } },
    { entity_id: 'sensor.temperature', state: '20', attributes: {} },
  ];
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/states' ? states : states[0]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = ConfigSchema.parse({
    homeAssistant: {
      token: 'test',
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      sensorEntities: ['person.a', 'zone.office'],
    },
  }).homeAssistant;
  const ha = new HomeAssistant(config);
  try {
    const page = await ha.locationEntities('', 0, 1);
    assert.equal(page.total, 2);
    assert.equal(page.next_offset, 1);
    assert.equal(page.items[0].entity_id, 'person.a');
    assert.deepEqual(
      (await ha.locationEntities('office', 0, 10)).items.map((s: any) => s.entity_id),
      ['zone.office'],
    );
    assert.equal((await ha.locationEntity('person.a')).attributes.private, undefined);
    await assert.rejects(ha.locationEntity('person.private'), /not permitted/);
    const tools = new Tools({ audit: async () => {} });
    registerHomeAssistantTools(tools, ha, config);
    assert.ok(tools.definitions().some((t) => t.name === 'ha_location_entities'));
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('direct distance tool computes metres, qualifies old observations and rejects unusable coordinates', async () => {
  const now = new Date().toISOString();
  const states: Record<string, any> = {
    'person.ken': {
      entity_id: 'person.ken',
      state: 'not_home',
      last_reported: now,
      attributes: {
        friendly_name: 'Ken',
        latitude: 0,
        longitude: 179.99,
        gps_accuracy: 10,
        private: 'omit',
      },
    },
    'person.francisco': {
      entity_id: 'person.francisco',
      state: 'not_home',
      last_reported: now,
      attributes: { friendly_name: 'Francisco', latitude: 0, longitude: -179.99, gps_accuracy: 15 },
    },
  };
  const requests: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    requests.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    const entity = decodeURIComponent(req.url!.split('/').at(-1)!);
    res.end(JSON.stringify(entity === 'states' ? Object.values(states) : states[entity]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = ConfigSchema.parse({
    homeAssistant: {
      token: 'test',
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      sensorEntities: Object.keys(states),
    },
  }).homeAssistant;
  const ha = new HomeAssistant(config);
  const tools = new Tools({ audit: async () => {} });
  registerHomeAssistantTools(tools, ha, config);
  const ctx = { session: 'telegram:-42', jobId: 'distance', signal: AbortSignal.timeout(10000) };
  const read = () =>
    tools.call(
      'ha_distance',
      { person_a: 'person.ken', person_b: 'person.francisco' },
      ctx,
    ) as ReturnType<HomeAssistant['distance']>;
  try {
    assert.ok(tools.definitions().some((t) => t.name === 'ha_distance'));
    assert.equal(toolCapability('ha_distance'), 'homeAssistant');
    const discovered = await ha.locationEntities('francisco', 0, 20);
    assert.equal(discovered.items[0].entity_id, 'person.francisco');
    const result = await read();
    assert.equal(result.available, true);
    assert.equal(result.current, true);
    assert.equal(result.method, 'straight_line');
    assert.equal(result.distance_m, 2224);
    assert.equal(result.locations[0]!.name, 'Ken');
    assert.equal(result.locations[1]!.gps_accuracy_m, 15);
    assert.ok(result.locations.every((location) => location.age_seconds! < 10));
    assert.ok(!JSON.stringify(result).includes('private'));
    const count = requests.length;
    await assert.rejects(ha.distance('person.ken', 'person.private'), /not permitted/);
    await assert.rejects(ha.distance('person.ken', 'zone.home'), /not permitted/);
    await assert.rejects(
      tools.call('ha_distance', { person_a: 'person.ken', person_b: 'person.ken' }, ctx),
      /different people/,
    );
    await assert.rejects(tools.call('ha_distance', { user_a: '12', user_b: '13' }, ctx));
    assert.equal(requests.length, count);
    const original = structuredClone(states['person.francisco']);
    const invalid = [
      { state: 'unavailable', status: 'unavailable', computable: true },
      {
        last_reported: new Date(Date.now() - 7200000).toISOString(),
        status: 'stale',
        computable: true,
      },
      { last_reported: 'invalid', status: 'invalid_timestamp', computable: true },
      {
        last_reported: new Date(Date.now() + 600000).toISOString(),
        status: 'invalid_timestamp',
        computable: true,
      },
      {
        attributes: { latitude: 91, longitude: 0 },
        status: 'invalid_coordinates',
        computable: false,
      },
      {
        attributes: { latitude: 0, longitude: -179.99, gps_accuracy: 201 },
        status: 'inaccurate',
        computable: true,
      },
      {
        attributes: { latitude: '0', longitude: 0 },
        status: 'invalid_coordinates',
        computable: false,
      },
      { state: 'unavailable', attributes: {}, status: 'unavailable', computable: false },
    ];
    for (const { status, computable, ...change } of invalid) {
      states['person.francisco'] = { ...original, ...change };
      const unavailable = await read();
      assert.equal(unavailable.available, computable);
      assert.equal(unavailable.current, false);
      assert.equal(unavailable.distance_m, computable ? 2224 : null);
      assert.equal(unavailable.locations[1]!.status, status);
      if (status === 'stale') assert.ok(unavailable.locations[1]!.age_seconds! >= 7200);
    }
    states['person.francisco'] = {
      ...original,
      last_reported: undefined,
      last_updated: now,
      attributes: { latitude: 0, longitude: 179.99 },
    };
    assert.equal((await read()).distance_m, 0);
    const blocked = new Tools({ audit: async () => {} }, async () => false);
    registerHomeAssistantTools(blocked, ha, config);
    await assert.rejects(
      blocked.call('ha_distance', { person_a: 'person.ken', person_b: 'person.francisco' }, ctx),
      /not permitted/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('group distance uses assigned member locations without requiring person allowlist discovery', async () => {
  const now = new Date().toISOString();
  const config = ConfigSchema.parse({
    homeAssistant: { token: 'group-test', sensorEntities: ['sensor.temperature'] },
  }).homeAssistant;
  const tools = new Tools({ audit: async () => {} });
  const calls: string[] = [];
  registerHomeAssistantTools(tools, new HomeAssistant(config), config, {
    async list() {
      return {
        items: [
          { userId: '12', name: 'Ken' },
          { userId: '13', name: 'Francisco' },
        ],
        total: 2,
      };
    },
    async location(userId) {
      calls.push(userId);
      if (!['12', '13'].includes(userId))
        throw new Error('No active location assignment in this group');
      const source = {
        entity_id: userId === '12' ? 'device_tracker.ken' : 'sensor.francisco_address',
        available: true,
        state: 'not_home',
        last_reported: userId === '12' ? now : new Date(Date.now() - 7200000).toISOString(),
        coordinates: { latitude: 0, longitude: userId === '12' ? 0 : 0.01, accuracy_m: 10 },
      };
      return userId === '12'
        ? { tracker: source, geocoded: null }
        : { tracker: null, geocoded: source };
    },
  });
  const ctx = {
    session: 'telegram:-42',
    jobId: 'group-distance',
    signal: AbortSignal.timeout(10000),
  };
  const result: any = await tools.call('ha_distance', { user_a: '12', user_b: '13' }, ctx);
  assert.equal(result.distance_m, 1112);
  assert.equal(result.available, true);
  assert.equal(result.current, false);
  assert.equal(result.locations[1].user_id, '13');
  assert.equal(result.locations[1].status, 'stale');
  assert.ok(result.locations[1].age_seconds >= 7200);
  assert.deepEqual(calls, ['12', '13']);
  await assert.rejects(
    tools.call('ha_distance', { user_a: '12', user_b: '99' }, ctx),
    /No active location assignment/,
  );
  await assert.rejects(
    tools.call('ha_distance', { user_a: '12', user_b: '12' }, ctx),
    /different members/,
  );
  await assert.rejects(
    tools.call('ha_distance', { user_a: '12', user_b: '13', person_a: 'person.private' }, ctx),
  );
});
