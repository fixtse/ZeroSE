import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventWeatherContext,
  eventWeatherImpacts,
  eventWeatherWindows,
  relevantWeatherChange,
} from '../src/domain/event-weather.js';
import { WeatherNotification, weatherFacts } from '../src/application/weather-notification.js';
import type { WeatherChange } from '../src/domain/weather-change.js';
import type { GooglePort } from '../src/application/ports.js';

const now = new Date('2026-10-25T00:00:00Z');
const event = {
  id: 'walk',
  summary: 'Paseo',
  location: 'Parque',
  start: { dateTime: '2026-10-25T02:30:00+01:00' },
  end: { dateTime: '2026-10-25T03:30:00+01:00' },
};
const rain: WeatherChange = {
  forecast_type: 'hourly',
  entity_id: 'weather.home',
  units: { temperature: '°C', wind_speed: 'km/h', precipitation: 'mm' },
  changes: [
    {
      datetime: '2026-10-25T01:00:00Z',
      before: { condition: 'sunny', precipitation: 0 },
      after: { condition: 'rainy', precipitation: 2 },
    },
  ],
  truncated: false,
};

test('event windows identify physical outings, exclude remote/home/cancelled/declined/all-day/unknown plans and handle DST', () => {
  const candidates = [
    event,
    { ...event, id: 'home', location: 'Casa' },
    { ...event, id: 'zoom', location: 'https://zoom.us/123' },
    { ...event, id: 'remote', summary: 'Reunión online', location: '' },
    { ...event, id: 'unknown', summary: 'Reunión', location: '' },
    { ...event, id: 'cancelled', status: 'cancelled' },
    { ...event, id: 'declined', attendees: [{ self: true, responseStatus: 'declined' }] },
    { ...event, id: 'all-day', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } },
    { ...event, id: 'outdoor', location: '' },
    { ...event, id: 'video', location: '', conferenceData: {} },
  ];
  const windows = eventWeatherWindows(candidates, now);
  assert.deepEqual(
    windows.map((value) => value.id),
    ['walk', 'outdoor'],
  );
  assert.equal(windows[0]?.window_start, '2026-10-25T01:00:00.000Z');
  assert.equal(windows[0]?.window_end, '2026-10-25T02:45:00.000Z');
  const context = eventWeatherContext(
    [event],
    {
      forecast: [
        { datetime: '2026-10-25T00:00:00Z', temperature: 12 },
        { datetime: '2026-10-25T01:00:00Z', temperature: 11 },
        { datetime: '2026-10-25T02:00:00Z', temperature: 10 },
        { datetime: '2026-10-25T03:00:00Z', temperature: 9 },
      ],
    },
    now,
    'Europe/Madrid',
  );
  assert.equal(context[0]?.local_start, '25/10/26, 2:30');
  assert.equal(context[0]?.local_end, '25/10/26, 3:30');
  assert.deepEqual(
    context[0]?.forecast.map((period) => period.temperature),
    [11, 10],
  );
  assert.equal(context[0]?.forecast_scope, 'home_area_not_verified_at_destination');
});

test('event impact requires a material before/after change at an overlapping future hour, including improvements', () => {
  assert.equal(eventWeatherImpacts([event], rain, now, 'Europe/Madrid').length, 1);
  const period = rain.changes[0]!;
  assert(
    relevantWeatherChange({ ...period, before: period.after, after: period.before }, rain.units),
  );
  assert(
    !relevantWeatherChange(
      { ...period, before: { temperature: 20 }, after: { temperature: 21 } },
      rain.units,
    ),
  );
  assert(!relevantWeatherChange({ ...period, before: null }, rain.units));
  assert(
    !relevantWeatherChange(
      { ...period, before: { precipitation: null }, after: { precipitation: 1 } },
      rain.units,
    ),
  );
  assert(
    relevantWeatherChange(
      { ...period, before: { wind_speed: 15 }, after: { wind_speed: 22 } },
      { wind_speed: 'mph' },
    ),
  );
  assert(
    relevantWeatherChange(
      { ...period, before: { temperature: 80 }, after: { temperature: 90 } },
      { temperature: '°F' },
    ),
  );
  assert(
    !relevantWeatherChange(
      { ...period, before: { wind_speed: 15 }, after: { wind_speed: 40 } },
      {},
    ),
  );
  assert.equal(
    eventWeatherImpacts(
      [event],
      { ...rain, changes: [{ ...period, datetime: '2026-10-25T05:00:00Z' }] },
      now,
      'Europe/Madrid',
    ).length,
    0,
  );
  assert.equal(
    eventWeatherImpacts([event], rain, new Date('2026-10-25T04:00:00Z'), 'Europe/Madrid').length,
    0,
  );
});

test('hourly update rechecks current agenda, scopes captured evidence, suppresses irrelevant updates and retains event details on model failure', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  let events = [event],
    calls = 0,
    reads = 0;
  const calendar: GooglePort = {
    enabled: true,
    events: async (start, end) => {
      reads++;
      assert.equal(start, now.toISOString());
      assert.equal(end, '2026-10-26T00:00:00.000Z');
      return events;
    },
    tasks: async () => [],
    context: async () => '',
    cleanTasks: async () => ({ deleted: 0 }),
  };
  const context = {
    session: 'telegram:owner',
    jobId: 'weather',
    signal: new AbortController().signal,
  };
  const service = new WeatherNotification({
    run: async (_session, prompt, instructions, _context, _images, _schema, tools) => {
      calls++;
      const data = JSON.parse(prompt);
      assert.equal(data.affected_events[0].title, 'Paseo');
      assert.equal(data.evidence.changes.length, 1);
      assert.equal(data.forecast_type, 'hourly');
      assert.match(instructions, /no está verificada en el destino/);
      assert.equal(tools, false);
      return 'Para tu paseo de las 2:30, ahora se espera lluvia en la zona de casa; lleva impermeable.';
    },
  });
  assert.equal(
    (await service.update(rain, now.toISOString(), 'Europe/Madrid', context)).deliver,
    false,
  );
  assert.equal(reads, 0);
  const result = await service.update(rain, now.toISOString(), 'Europe/Madrid', context, calendar);
  assert.match(result.output, /paseo/);
  assert.equal(calls, 1);
  events = [{ ...event, status: 'cancelled' } as typeof event];
  assert.equal(
    (await service.update(rain, now.toISOString(), 'Europe/Madrid', context, calendar)).deliver,
    false,
  );
  assert.equal(calls, 1);
  events = [event];
  const minor = {
    ...rain,
    changes: [{ ...rain.changes[0]!, before: { temperature: 20 }, after: { temperature: 21 } }],
  };
  assert.equal(
    (await service.update(minor, now.toISOString(), 'Europe/Madrid', context, calendar)).deliver,
    false,
  );
  assert.equal(reads, 2);
  const failed = new WeatherNotification({
    run: async () => {
      throw new Error('unavailable');
    },
  });
  const fallback = await failed.update(rain, now.toISOString(), 'Europe/Madrid', context, calendar);
  assert.match(fallback.output, /Paseo.*2:30/);
  assert.match(fallback.output, /destino sin verificar/);
  assert.match(
    weatherFacts(
      {
        ...rain,
        changes: [{ ...rain.changes[0]!, before: { temperature: 20 }, after: { temperature: 30 } }],
      },
      'Europe/Madrid',
    ),
    /temperatura: 20 °C → 30 °C/,
  );
});
