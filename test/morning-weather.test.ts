import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { PrepareNotification } from '../src/application/use-cases/prepare-notification.js';
import type { ConversationStore } from '../src/application/ports.js';

test('wake-up briefing discovers daily weather, honors explicit configuration and handles missing forecasts', async () => {
  let sources: unknown = [
    { entity_id: 'weather.forecast_home', attributes: { supported_features: 3 } },
    { entity_id: 'weather.hourly_only', attributes: { supported_features: 2 } },
    { entity_id: 'sensor.temperature', attributes: { supported_features: 1 } },
  ];
  let fail = false;
  const requests: string[] = [];
  const forecast = { forecast: [{ datetime: '2026-10-17T12:00:00Z', temperature: 23 }] };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only');
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/states') {
      res.end(JSON.stringify(sources));
      return;
    }
    assert.equal(req.url, '/api/services/weather/get_forecasts?return_response');
    assert.equal(req.method, 'POST');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.type, 'daily');
    if (fail) {
      res.writeHead(503).end('{}');
      return;
    }
    res.end(JSON.stringify({ service_response: { [body.entity_id]: forecast } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = ConfigSchema.parse({
    homeAssistant: {
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      token: 'test-only',
      weatherEntity: '',
    },
  });
  let weather: unknown;
  const briefing = new PrepareNotification(
    config,
    {} as ConversationStore,
    {
      run: async (_session, prompt) => {
        weather = JSON.parse(prompt).weather;
        return 'Buenos días';
      },
    },
    {
      enabled: false,
      events: async () => [],
      tasks: async () => [],
      context: async () => '',
      cleanTasks: async () => ({ deleted: 0 }),
    },
    new HomeAssistant(config.homeAssistant),
    {},
  );
  const run = () =>
    briefing.execute(
      { id: 'wake-up', session: 'telegram:owner', payload: { kind: 'morning' }, status: 'running' },
      { jobId: 'wake-up', session: 'telegram:owner', signal: new AbortController().signal },
    );
  try {
    await run();
    assert.deepEqual(weather, { service_response: { 'weather.forecast_home': forecast } });
    assert.equal(requests[0], 'GET /api/states');
    assert.equal(config.homeAssistant.weatherEntity, '');

    for (const invalid of [
      [],
      [
        { entity_id: 'weather.one', attributes: { supported_features: 1 } },
        { entity_id: 'weather.two', attributes: { supported_features: 1 } },
      ],
    ]) {
      sources = invalid;
      requests.length = 0;
      await run();
      assert.equal(weather, 'Weather could not be retrieved; mention this to the user');
      assert.deepEqual(requests, ['GET /api/states']);
    }

    config.homeAssistant.weatherEntity = 'weather.selected';
    requests.length = 0;
    await run();
    assert.deepEqual(weather, { service_response: { 'weather.selected': forecast } });
    assert.deepEqual(requests, ['POST /api/services/weather/get_forecasts?return_response']);

    fail = true;
    await run();
    assert.equal(weather, 'Weather could not be retrieved; mention this to the user');

    config.homeAssistant.token = '';
    requests.length = 0;
    await run();
    assert.equal(weather, 'Weather is not configured');
    assert.deepEqual(requests, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
