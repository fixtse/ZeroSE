import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenStreetMapPlaces } from '../src/adapters/outbound/places.js';
import { toolCapability } from '../src/domain/access.js';

test('place lookups and estimates include usable Maps links and correctly label unsupported travel modes', async () => {
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    requests.push(url);
    if (url.searchParams.get('lang') === 'es') {
      res.writeHead(400);
      res.end('Spanish is not a supported Photon demo language');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        url.pathname === '/api/'
          ? {
              features: [
                {
                  properties: { name: 'A & B Café', city: 'Madrid', osm_type: 'N', osm_id: 123 },
                  geometry: { coordinates: [-3.7, 40.4] },
                },
              ],
            }
          : { code: 'Ok', routes: [{ duration: 123.4, distance: 2000.6 }] },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const places = new OpenStreetMapPlaces(base, base),
    signal = AbortSignal.timeout(10000);
  try {
    const results = await places.search(
      'A & B Café',
      { latitude: 40.4, longitude: -3.7 },
      5,
      signal,
    );
    assert.equal(requests[0].searchParams.get('q'), 'A & B Café');
    assert.equal(requests[0].searchParams.get('lat'), '40.4');
    assert.equal(new URL(results[0].maps_url).searchParams.get('query'), '40.4,-3.7');
    assert.equal(results[0].source_url, 'https://www.openstreetmap.org/node/123');
    const route = (await places.route(
      results[0].coordinates,
      { latitude: 40.5, longitude: -3.6 },
      'driving',
      signal,
    )) as any;
    assert.equal(route.traffic_aware, false);
    assert.equal(route.duration_seconds, 123);
    assert.equal(new URL(route.maps_url).searchParams.get('destination'), '40.5,-3.6');
    assert.match(requests[1].pathname, /-3.7,40.4;-3.6,40.5/);
    const walking = (await places.route(
      results[0].coordinates,
      results[0].coordinates,
      'walking',
      signal,
    )) as any;
    assert.equal(walking.duration_seconds, null);
    assert.equal(requests.length, 2);
    assert.equal(toolCapability('route_estimate'), 'web');
    assert.equal(toolCapability('weather_alert_create'), 'homeAssistant');
    assert.equal(toolCapability('alert_change'), 'homeAssistant');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
