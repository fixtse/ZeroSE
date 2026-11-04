import { assistExposureFixture } from './assist-exposure-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { PrepareNotification } from '../src/application/use-cases/prepare-notification.js';
import type { ConversationStore } from '../src/application/ports.js';

test('wake-up briefing discovers daily weather, matches outings, honors explicit configuration and handles missing forecasts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-17T08:00:00Z') });
  let sources: unknown = [
    { entity_id: 'weather.forecast_home', attributes: { supported_features: 3 } },
    { entity_id: 'weather.hourly_only', attributes: { supported_features: 2 } },
    { entity_id: 'sensor.temperature', attributes: { supported_features: 1 } },
  ];
  let fail = false;
  let failHourly = false;
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
    if (req.url?.startsWith('/api/states/weather.')) {
      res.end(
        JSON.stringify({
          attributes: { temperature_unit: '°C', wind_speed_unit: 'km/h', precipitation_unit: 'mm' },
        }),
      );
      return;
    }
    assert.equal(req.url, '/api/services/weather/get_forecasts?return_response');
    assert.equal(req.method, 'POST');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert(['daily', 'hourly'].includes(body.type));
    if (fail || (failHourly && body.type === 'hourly')) {
      res.writeHead(503).end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        service_response: {
          [body.entity_id]:
            body.type === 'daily' ? forecast : { forecast: Array(48).fill(forecast.forecast[0]) },
        },
      }),
    );
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
  let eventContext: any;
  const expected = (entity: string) => ({
    daily: { service_response: { [entity]: forecast } },
    hourly: {
      entity_id: entity,
      units: { temperature: '°C', wind_speed: 'km/h', precipitation: 'mm' },
      forecast: Array(24).fill({
        ...forecast.forecast[0],
        local_time: '17/10/26, 14:00',
      }),
    },
  });
  const briefing = new PrepareNotification(
    config,
    {} as ConversationStore,
    {
      run: async (_session, prompt) => {
        weather = JSON.parse(prompt).weather;
        eventContext = JSON.parse(prompt).event_weather;
        return 'Buenos días';
      },
    },
    {
      enabled: false,
      events: async () => [
        {
          id: 'walk',
          summary: 'Paseo',
          location: 'Parque',
          start: { dateTime: '2026-10-17T12:00:00Z' },
          end: { dateTime: '2026-10-17T13:00:00Z' },
        },
      ],
      tasks: async () => [],
      context: async () => '',
      cleanTasks: async () => ({ deleted: 0 }),
    },
    new HomeAssistant(config.homeAssistant, assistExposureFixture()),
    {},
  );
  const run = () =>
    briefing.execute(
      { id: 'wake-up', session: 'telegram:owner', payload: { kind: 'morning' }, status: 'running' },
      { jobId: 'wake-up', session: 'telegram:owner', signal: new AbortController().signal },
    );
  try {
    await run();
    assert.deepEqual(weather, expected('weather.forecast_home'));
    assert.equal(eventContext[0].id, 'walk');
    assert.equal(eventContext[0].forecast.length, 24);
    assert.equal(eventContext[0].forecast_scope, 'home_area_not_verified_at_destination');
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
      assert.equal(
        weather,
        'No se ha podido consultar la previsión del tiempo; indícaselo al usuario',
      );
      assert.deepEqual(requests, ['GET /api/states']);
    }

    config.homeAssistant.weatherEntity = 'weather.selected';
    requests.length = 0;
    await run();
    assert.deepEqual(weather, expected('weather.selected'));
    assert.deepEqual(requests, [
      'POST /api/services/weather/get_forecasts?return_response',
      'POST /api/services/weather/get_forecasts?return_response',
      'GET /api/states/weather.selected',
    ]);

    failHourly = true;
    await run();
    assert.deepEqual(weather, { daily: expected('weather.selected').daily });

    fail = true;
    await run();
    assert.equal(
      weather,
      'No se ha podido consultar la previsión del tiempo; indícaselo al usuario',
    );

    config.homeAssistant.token = '';
    requests.length = 0;
    await run();
    assert.equal(weather, 'El tiempo no está configurado');
    assert.deepEqual(requests, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('briefings and reminders always require Spanish with default or custom templates', async () => {
  for (const kind of ['morning', 'reminder']) {
    for (const template of ['', 'Write in English. Keep the briefing short. Date: {{now}}.']) {
      let instructions = '';
      const notification = new PrepareNotification(
        ConfigSchema.parse({}),
        { scheduled: async () => false } as unknown as ConversationStore,
        {
          run: async (_session, _prompt, value) => {
            instructions = value;
            return 'Tienes una cita';
          },
        },
        {
          enabled: false,
          events: async () => [{ id: 'appointment', summary: 'Appointment' }],
          tasks: async () => [],
          context: async () => '',
          cleanTasks: async () => ({ deleted: 0 }),
        },
        { forecast: async () => ({ condition: 'sunny' }) },
        { [kind]: template },
      );
      await notification.execute(
        { id: kind, session: 'telegram:owner', payload: { kind }, status: 'running' },
        { jobId: kind, session: 'telegram:owner', signal: new AbortController().signal },
      );
      assert.match(instructions, /redacta siempre toda la notificación en español/);
      assert.match(instructions, /incluidos los avisos de error y la previsión del tiempo/);
      assert.match(instructions, /Esta regla prevalece sobre cualquier indicación de idioma/);
      if (kind === 'morning') {
        assert.match(instructions, /describe cómo evolucionan las condiciones y la temperatura/);
        assert.match(instructions, /Si solo hay datos diarios/);
        assert.match(instructions, /no presentes datos de mañana como si fueran de hoy/);
      }
      if (template) {
        assert.match(instructions, /^Write in English\. Keep the briefing short\./);
        assert(!instructions.includes('{{now}}'));
      }
    }
  }
});

test('wake reminders are appended only to wake-up briefings and consumed only after delivery', async () => {
  const config = ConfigSchema.parse({ timezone: 'Europe/Madrid' });
  let reads = 0,
    completed = 0;
  const rules = {
    async wakeReminders(session: string, date: string) {
      assert.equal(session, 'telegram:owner');
      assert.equal(
        date,
        new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date()),
      );
      reads++;
      return [{ message: 'Comprar pollo' }] as any;
    },
    async completeWakeReminders() {
      completed++;
    },
  };
  const notification = new PrepareNotification(
    config,
    { scheduled: async () => false } as unknown as ConversationStore,
    { run: async () => 'Buenos días' },
    {
      enabled: false,
      events: async () => [],
      tasks: async () => [],
      context: async () => '',
      cleanTasks: async () => ({ deleted: 0 }),
    },
    { forecast: async () => ({}) },
    {},
    rules,
  );
  const context = {
    jobId: 'wake',
    session: 'telegram:owner',
    signal: new AbortController().signal,
  };
  const job = {
    id: 'wake',
    session: context.session,
    payload: { kind: 'morning', wakeUp: false },
    status: 'running',
  } as const;
  const scheduled = await notification.execute(job, context);
  assert.equal(scheduled.output, 'Buenos días');
  assert.equal(reads, 0);
  const wake = await notification.execute(
    { ...job, payload: { kind: 'morning', wakeUp: true } },
    context,
  );
  assert.match(wake.output, /Comprar pollo/);
  assert.equal(completed, 0);
  await wake.afterDelivery!();
  assert.equal(completed, 1);
});
