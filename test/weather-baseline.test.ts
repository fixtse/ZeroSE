import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulateWeather, reportedWeather } from '../src/domain/weather-baseline.js';
import { WeatherNotification } from '../src/application/weather-notification.js';
import type { WeatherChange } from '../src/domain/weather-change.js';

const at = Date.parse('2026-11-04T12:00:00Z');
const period = '2026-11-04T13:00:00Z';
function evidence(
  before: number,
  after: number,
  type: 'daily' | 'hourly' = 'hourly',
): WeatherChange {
  return {
    forecast_type: type,
    entity_id: 'weather.home',
    units: { temperature: '°C' },
    changes: [{ datetime: period, before: { temperature: before }, after: { temperature: after } }],
    truncated: false,
  };
}

test('small revisions accumulate from the last reported value, independently per field and period', () => {
  let pending = accumulateWeather(undefined, evidence(15, 15.2), at);
  pending = accumulateWeather(pending, evidence(15.2, 16.1), at);
  assert.equal(pending.changes[0]?.before?.temperature, 15);
  pending = reportedWeather(pending, pending);
  pending = accumulateWeather(pending, evidence(16.1, 17.1), at);
  assert.equal(pending.changes[0]?.before?.temperature, 16.1);
  assert.equal(pending.changes[0]?.after?.temperature, 17.1);
  pending = accumulateWeather(
    pending,
    {
      ...evidence(17.1, 17.2),
      changes: [{ datetime: period, before: { humidity: 50 }, after: { humidity: 51 } }],
    },
    at,
  );
  assert.equal(pending.changes[0]?.before?.temperature, 16.1);
  assert.equal(pending.changes[0]?.after?.temperature, 17.1);
  const later = accumulateWeather(pending, evidence(17.1, 18), at);
  const acknowledged = reportedWeather(later, {
    ...pending,
    changes: [{ datetime: period, before: { humidity: 50 }, after: { humidity: 51 } }],
  });
  assert.equal(acknowledged.changes[0]?.before?.temperature, 16.1);
  assert.equal(acknowledged.changes[0]?.after?.temperature, 18);
});

test('unit/source changes reset references; expired periods are pruned and storage is bounded', () => {
  const pending = accumulateWeather(undefined, evidence(15, 15.2), at);
  assert.equal(
    accumulateWeather(pending, { ...evidence(60, 61), units: { temperature: '°F' } }, at).changes[0]
      ?.before?.temperature,
    60,
  );
  assert.equal(accumulateWeather(pending, evidence(15.2, 16), at + 86400_000).changes.length, 0);
  const many = {
    ...evidence(15, 16),
    changes: Array.from({ length: 100 }, (_, i) => ({
      ...evidence(15, 16).changes[0]!,
      datetime: new Date(at + i * 3600_000).toISOString(),
    })),
  };
  const bounded = accumulateWeather(undefined, many, at);
  assert.equal(bounded.changes.length, 48);
  assert.equal(bounded.truncated, true);
});

test('daily and hourly alerts suppress slight changes and report cumulative >1°C only after delivery', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at });
  for (const type of ['daily', 'hourly'] as const) {
    let pending: WeatherChange | undefined;
    let delivered = 0;
    const service = new WeatherNotification({
      run: async () => 'La temperatura prevista sube de 15 a 16,1 °C.',
    });
    const context = {
      session: 'telegram:owner',
      jobId: type,
      signal: new AbortController().signal,
    };
    const update = async (before: number, after: number) => {
      pending = accumulateWeather(pending, evidence(before, after, type), at);
      return service.update(
        pending,
        new Date(at).toISOString(),
        'Europe/Madrid',
        context,
        undefined,
        async (sent) => {
          delivered++;
          pending = reportedWeather(pending!, sent);
        },
      );
    };
    assert.equal((await update(15, 15.2)).deliver, false);
    const first = await update(15.2, 16.1);
    assert.notEqual(first.deliver, false);
    assert.equal(delivered, 0);
    assert.equal(pending?.changes[0]?.before?.temperature, 15);
    // A failed Telegram send never calls this callback and never advances the reference.
    assert.notEqual((await update(16.1, 16.2)).deliver, false);
    await first.afterDelivery?.();
    assert.equal(delivered, 1);
    assert.equal(pending?.changes[0]?.before?.temperature, 16.1);
    assert.equal((await update(16.2, 17.1)).deliver, false);
    const second = await update(17.1, 17.2);
    assert.notEqual(second.deliver, false);
    await second.afterDelivery?.();
    assert.equal(delivered, 2);
  }
});
