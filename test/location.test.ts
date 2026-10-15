import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { registerHomeAssistantTools } from '../src/adapters/inbound/integration-tools.js';
import { Tools } from '../src/application/tool-registry.js';

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
