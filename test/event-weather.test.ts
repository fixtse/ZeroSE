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

test('material hourly weather is delivered without events or calendar access, with optional current event context', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now });
  let events = [event],
    reads = 0;
  const prompts: any[] = [];
  const calendar: GooglePort = {
    enabled: true,
    events: async () => {
      reads++;
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
    run: async (_session, prompt, _instructions, _context, _images, _schema, tools) => {
      prompts.push(JSON.parse(prompt));
      assert.equal(tools, false);
      return 'Ahora se prevé lluvia a las 2:00 en la zona de casa; lleva impermeable.';
    },
  });
  const general = await service.update(rain, now.toISOString(), 'Europe/Madrid', context);
  assert.match(general.output, /lluvia/);
  assert.notEqual(general.deliver, false);
  assert.equal(general.requiredCapabilities, undefined);
  assert.deepEqual(prompts.at(-1).affected_events, []);
  assert.equal(reads, 0);

  const contextual = await service.update(
    rain,
    now.toISOString(),
    'Europe/Madrid',
    context,
    calendar,
  );
  assert.deepEqual(contextual.requiredCapabilities, ['calendar']);
  assert.equal(prompts.at(-1).affected_events[0].title, 'Paseo');
  events = [];
  assert.notEqual(
    (await service.update(rain, now.toISOString(), 'Europe/Madrid', context, calendar)).deliver,
    false,
  );
  assert.deepEqual(prompts.at(-1).affected_events, []);
  events = [{ ...event, status: 'cancelled' } as typeof event];
  assert.notEqual(
    (await service.update(rain, now.toISOString(), 'Europe/Madrid', context, calendar)).deliver,
    false,
  );
  assert.deepEqual(prompts.at(-1).affected_events, []);

  const failedCalendar = {
    ...calendar,
    events: async () => {
      throw new Error('Calendar unavailable');
    },
  };
  assert.notEqual(
    (await service.update(rain, now.toISOString(), 'Europe/Madrid', context, failedCalendar))
      .deliver,
    false,
  );
  assert.deepEqual(prompts.at(-1).affected_events, []);

  const callsBefore = prompts.length,
    readsBefore = reads;
  for (const changes of [
    [{ ...rain.changes[0]!, before: { temperature: 20 }, after: { temperature: 21 } }],
    [{ ...rain.changes[0]!, datetime: '2026-10-24T20:00:00Z' }],
    [{ ...rain.changes[0]!, datetime: '2026-10-26T01:00:00Z' }],
    [{ ...rain.changes[0]!, before: null }],
  ]) {
    assert.equal(
      (
        await service.update(
          { ...rain, changes },
          now.toISOString(),
          'Europe/Madrid',
          context,
          calendar,
        )
      ).deliver,
      false,
    );
  }
  assert.equal(prompts.length, callsBefore);
  assert.equal(reads, readsBefore);

  const failed = new WeatherNotification({
    run: async () => {
      throw new Error('unavailable');
    },
  });
  const fallback = await failed.update(rain, now.toISOString(), 'Europe/Madrid', context);
  assert.match(fallback.output, /soleado → lluvia/);
  events = [event];
  assert.match(
    (await failed.update(rain, now.toISOString(), 'Europe/Madrid', context, calendar)).output,
    /Paseo.*2:30/,
  );
});

test('rain moving into 17:00 is notified without a matching activity, while retaining other relevant hours', async (t) => {
  const at = new Date('2026-10-17T14:03:55Z');
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const change: WeatherChange = {
    ...rain,
    changes: [
      {
        datetime: '2026-10-17T15:00:00Z',
        before: { condition: 'cloudy', precipitation: 0 },
        after: { condition: 'rainy', precipitation: 0.3 },
      },
      {
        datetime: '2026-10-17T16:00:00Z',
        before: { condition: 'partlycloudy', precipitation: 0 },
        after: { condition: 'rainy', precipitation: 0.1 },
      },
      { datetime: '2026-10-17T14:00:00Z', before: { temperature: 25 }, after: null },
    ],
  };
  const service = new WeatherNotification({
    run: async (_session, prompt) => {
      const data = JSON.parse(prompt);
      assert.deepEqual(data.evidence.changes, change.changes.slice(0, 2));
      assert.deepEqual(data.affected_events, []);
      assert.match(data.facts, /17:00/);
      assert.match(data.facts, /18:00/);
      return 'Ahora se prevé lluvia a las 17:00 y 18:00; antes esas horas aparecían secas.';
    },
  });
  const result = await service.update(change, at.toISOString(), 'Europe/Madrid', {
    session: 'owner',
    jobId: 'rain-advance',
    signal: new AbortController().signal,
  });
  assert.match(result.output, /17:00 y 18:00/);
  assert.notEqual(result.deliver, false);
  assert.equal(result.requiredCapabilities, undefined);
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
