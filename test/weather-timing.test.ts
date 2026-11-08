import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourlyWeatherTimes } from '../src/domain/weather-timing.js';
import type { WeatherChange } from '../src/domain/weather-change.js';

const change: WeatherChange = {
  entity_id: 'weather.home',
  forecast_type: 'daily',
  units: {},
  changes: [
    {
      datetime: '2026-11-08T00:00:00Z',
      before: { condition: 'sunny' },
      after: { condition: 'rainy' },
    },
  ],
  truncated: false,
};
const now = new Date('2026-11-08T08:00:00Z');
const hourly = {
  entity_id: 'weather.home',
  units: { precipitation: 'mm' },
  forecast: [
    { datetime: '2026-11-08T12:00:00Z', condition: 'rainy' },
    { datetime: '2026-11-08T10:00:00Z', precipitation: 0.5 },
    { datetime: '2026-11-08T07:00:00Z', condition: 'rainy' },
  ],
};

test('rain timing uses the earliest upcoming hourly rain on the affected local day', () => {
  assert.deepEqual(hourlyWeatherTimes(change, hourly, now, 'Europe/Madrid'), [
    { kind: 'rain', datetime: '2026-11-08T10:00:00.000Z' },
  ]);
});

test('rain timing rejects other entities, days, invalid dates and unavailable hourly data', () => {
  for (const data of [
    undefined,
    { ...hourly, entity_id: 'weather.other' },
    { ...hourly, forecast: [{ datetime: '2026-11-09T10:00:00Z', condition: 'rainy' }] },
    { ...hourly, forecast: [{ datetime: 'invalid', condition: 'rainy' }] },
    { ...hourly, forecast: [{ datetime: '2026-11-08T10:00:00Z', condition: 'sunny' }] },
  ])
    assert.deepEqual(hourlyWeatherTimes(change, data, now, 'Europe/Madrid'), []);
});

import { WeatherNotification } from '../src/application/weather-notification.js';

test('rain timing is retained even when the model omits it or fails', async () => {
  for (const response of ['Rain is expected.', '']) {
    let captured: unknown;
    const notification = new WeatherNotification(
      {
        async run(_session, prompt) {
          const data = JSON.parse(prompt);
          captured = data.hourly_timing;
          return response;
        },
      },
      undefined,
      'en',
    );
    const result = await notification.explain(
      change,
      now.toISOString(),
      'Europe/Madrid',
      {
        session: 'test',
        jobId: 'rain-timing',
        signal: new AbortController().signal,
      },
      [],
      [{ kind: 'rain', datetime: '2026-11-08T10:00:00.000Z' }],
    );
    assert.deepEqual(captured, [{ kind: 'rain', datetime: '2026-11-08T10:00:00.000Z' }]);
    assert.match(result, /First forecast hour with rain.*11:00/);
  }
});

test('hourly timing covers storms, snow, wind, heat, frost, fog, hail and UV using supplied units', () => {
  const cases: [string, Record<string, string | number>, WeatherChange['units']][] = [
    ['storm', { condition: 'lightning' }, {}],
    ['snow', { condition: 'snowy' }, {}],
    ['wind', { wind_gust_speed: 20 }, { wind_speed: 'm/s' }],
    ['heat', { temperature: 100 }, { temperature: '°F' }],
    ['frost', { temperature: -2 }, { temperature: '°C' }],
    ['fog', { condition: 'fog' }, {}],
    ['hail', { condition: 'hail' }, {}],
    ['uv', { uv_index: 8 }, {}],
  ];
  for (const [kind, after, units] of cases) {
    const evidence = { ...change, units, changes: [{ ...change.changes[0]!, after }] };
    const data = {
      entity_id: change.entity_id,
      units,
      forecast: [
        { datetime: '2026-11-08T09:00:00Z', condition: 'rainy' },
        { datetime: '2026-11-08T12:00:00Z', ...after },
      ],
    };
    assert.deepEqual(
      hourlyWeatherTimes(evidence, data, now, 'Europe/Madrid'),
      [{ kind, datetime: '2026-11-08T12:00:00.000Z' }],
      kind,
    );
  }
});

test('numeric hazard timing requires hourly units and matches the affected local day', () => {
  const evidence: WeatherChange = {
    ...change,
    units: { wind_speed: 'km/h' },
    changes: [
      { ...change.changes[0]!, datetime: '2026-11-09T00:00:00+01:00', after: { wind_speed: 60 } },
    ],
  };
  const data = {
    entity_id: change.entity_id,
    forecast: [
      { datetime: '2026-11-08T10:00:00Z', wind_speed: 60 },
      { datetime: '2026-11-08T23:00:00Z', wind_speed: 60 },
    ],
  };
  assert.deepEqual(hourlyWeatherTimes(evidence, data, now, 'Europe/Madrid'), []);
  assert.deepEqual(
    hourlyWeatherTimes(evidence, { ...data, units: { wind_speed: 'km/h' } }, now, 'Europe/Madrid'),
    [{ kind: 'wind', datetime: '2026-11-08T23:00:00.000Z' }],
  );
});
