import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectWeatherNotification,
  type WeatherPreferences,
} from '../src/domain/weather-notifications.js';
import type { WeatherChange } from '../src/domain/weather-change.js';
import { WeatherNotification } from '../src/application/weather-notification.js';
import { PostgresRules } from '../src/adapters/outbound/postgres-rules.js';
import { NotificationRules } from '../src/application/notification-rules.js';
import { profileNotifications } from '../src/application/profile-notifications.js';
import { fixture } from './helpers.js';

const now = new Date('2026-11-08T08:00:00Z');
const preferences: WeatherPreferences = { mode: 'updates', routineIntervalHours: 6 };
const evidence = (
  before: Record<string, string | number>,
  after: Record<string, string | number>,
  at = '2026-11-08T12:00:00Z',
  type: 'daily' | 'hourly' = 'hourly',
): WeatherChange => ({
  entity_id: 'weather.home',
  forecast_type: type,
  units: { temperature: '°C', wind_speed: 'km/h', precipitation: 'mm' },
  changes: [{ datetime: at, before, after }],
  truncated: false,
});
const select = (
  change: WeatherChange,
  state?: Parameters<typeof selectWeatherNotification>[2],
  at = now,
  prefs = preferences,
) => selectWeatherNotification(change, prefs, state, at, 'Europe/Madrid');

test('routine forecasts share a six-hour delivery limit across daily and hourly updates', () => {
  const change = evidence({ temperature: 15 }, { temperature: 18 }, '2026-11-08T16:00:00Z');
  const sent = select(change);
  assert.equal(sent.change.changes.length, 1);
  assert.equal(select({ ...change, forecast_type: 'daily' }, sent.state).change.changes.length, 0);
  assert.equal(
    select(change, sent.state, new Date(now.getTime() + 6 * 3600_000)).change.changes.length,
    1,
  );
  assert.equal(select(evidence({ temperature: 15 }, { temperature: 17 })).change.changes.length, 0);
});

test('new rain and storms bypass a just-delivered routine update', () => {
  const sent = select(evidence({ temperature: 15 }, { temperature: 18 }));
  for (const condition of [
    'rainy',
    'lightning',
    'lightning-rainy',
    'hail',
    'snowy',
    'fog',
    'exceptional',
  ]) {
    const result = select(evidence({ condition: 'cloudy' }, { condition }), sent.state);
    assert.equal(result.reason, 'important_weather', condition);
    assert.equal(result.change.changes.length, 1, condition);
  }
});

test('daily and hourly revisions of reported rain stay quiet; materially worse rain alerts', () => {
  const rain = evidence({ precipitation: 0 }, { precipitation: 0.2, condition: 'rainy' });
  const sent = select(rain);
  assert.equal(
    select(evidence({ precipitation: 0.2 }, { precipitation: 0.8 }), sent.state).change.changes
      .length,
    0,
  );
  assert.equal(
    select(
      evidence({ precipitation: 5 }, { precipitation: 6 }, '2026-11-08T00:00:00Z', 'daily'),
      sent.state,
    ).change.changes.length,
    0,
  );
  assert.equal(
    select(evidence({ precipitation: 0.8 }, { precipitation: 3 }), sent.state).change.changes
      .length,
    1,
  );
  assert.equal(
    select(evidence({ condition: 'rainy' }, { condition: 'lightning-rainy' }), sent.state).change
      .changes.length,
    1,
  );
});

test('earlier rain, significant extensions and another rain episode alert within the same day', () => {
  const sent = select(evidence({ precipitation: 0 }, { precipitation: 0.2 }));
  assert.equal(
    select(
      evidence({ precipitation: 0 }, { precipitation: 0.2 }, '2026-11-08T11:00:00Z'),
      sent.state,
    ).change.changes.length,
    1,
  );
  assert.equal(
    select(
      evidence({ precipitation: 0 }, { precipitation: 0.2 }, '2026-11-08T11:30:00Z'),
      sent.state,
    ).change.changes.length,
    0,
  );
  assert.equal(
    select(
      evidence({ precipitation: 0 }, { precipitation: 0.2 }, '2026-11-08T17:00:00Z'),
      sent.state,
    ).change.changes.length,
    1,
  );
});

test('daily rain can receive one imminent hourly reminder without repeating small revisions', () => {
  const sent = select(
    evidence({ condition: 'cloudy' }, { condition: 'rainy' }, '2026-11-08T00:00:00Z', 'daily'),
  );
  const hourly = evidence({ precipitation: 0 }, { precipitation: 0.2 });
  const reminder = select(hourly, sent.state);
  assert.equal(reminder.change.changes.length, 1);
  assert.equal(select(hourly, reminder.state).change.changes.length, 0);
});

test('off, important only and all changes have distinct behavior; unchanged facts never repeat', () => {
  const rain = evidence({ condition: 'cloudy' }, { condition: 'rainy' });
  assert.equal(
    select(rain, undefined, now, { ...preferences, mode: 'off' }).change.changes.length,
    0,
  );
  const temperature = evidence({ temperature: 15 }, { temperature: 18 });
  assert.equal(
    select(temperature, undefined, now, { ...preferences, mode: 'important' }).change.changes
      .length,
    0,
  );
  assert.equal(
    select(evidence({ temperature: 15 }, { temperature: 15.1 }), undefined, now, {
      ...preferences,
      mode: 'all',
    }).change.changes.length,
    1,
  );
  assert.equal(
    select(evidence({ temperature: 15 }, { temperature: 15 }), undefined, now, {
      ...preferences,
      mode: 'all',
    }).change.changes.length,
    0,
  );
});

test('wind and temperature hazards respect supplied units and exclude expired and distant forecasts', () => {
  for (const change of [
    evidence({ wind_gust_speed: 10 }, { wind_gust_speed: 55 }),
    evidence({ temperature: 30 }, { temperature: 36 }),
    evidence({ temperature: 2 }, { temperature: -1 }),
    { ...evidence({ temperature: 80 }, { temperature: 100 }), units: { temperature: '°F' } },
    { ...evidence({ precipitation: 0 }, { precipitation: 0.1 }), units: { precipitation: 'in' } },
  ])
    assert.equal(select(change).reason, 'important_weather');
  assert.equal(
    select(evidence({ precipitation: 0 }, { precipitation: 2 }, '2026-11-07T12:00:00Z')).change
      .changes.length,
    0,
  );
  assert.equal(
    select(evidence({ precipitation: 0 }, { precipitation: 2 }, '2026-11-10T12:00:00Z')).change
      .changes.length,
    0,
  );
});

test('new periods with rain alert, history is bounded and a changed source has a fresh history', () => {
  const change = evidence({}, { condition: 'rainy' });
  change.changes[0]!.before = null;
  const sent = select(change);
  assert.equal(sent.change.changes.length, 1);
  assert.equal(
    select({ ...change, entity_id: 'weather.other' }, sent.state).change.changes.length,
    1,
  );
  assert.equal(
    select(change, { episodes: { expired: { severity: 1, expires: '2026-11-01T00:00:00Z' } } })
      .state.episodes.expired,
    undefined,
  );
});

test('delivery receipts persist shared weather history; evaluating or a failed send does not advance it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const f = await fixture();
  try {
    const repository = new PostgresRules(f.store.db);
    const rules = new NotificationRules(repository, async () => ({
      enabled: true,
      scheduler: {
        async ready() {},
        async configure() {},
        async supportsHourlyUpdates() {
          return true;
        },
        async inspect() {
          return { generation: 0, status: 'active' as const, next_at: null, muted: false };
        },
      },
    }));
    const rule = (await rules.ensureOwnerWeather('telegram:weather'))!;
    const change = evidence({ condition: 'cloudy' }, { condition: 'rainy' });
    await repository.weatherEvidence(rule.id, rule.generation, change);
    const service = new WeatherNotification({ run: async () => 'Rain expected at noon.' });
    const update = async () =>
      service.update(
        change,
        now.toISOString(),
        'Europe/Madrid',
        {
          session: rule.session,
          jobId: 'weather',
          signal: new AbortController().signal,
        },
        undefined,
        async (reported, state) => {
          await repository.weatherEvidence(rule.id, rule.generation, reported, true, state);
        },
        {
          preferences,
          state: (await repository.byId(rule.id))?.weather_delivery,
        },
      );
    const result = await update();
    assert.notEqual(result.deliver, false);
    assert.equal((await repository.byId(rule.id))?.weather_delivery, undefined);
    assert.notEqual((await update()).deliver, false);
    await result.afterDelivery?.();
    assert.equal(
      Object.keys((await repository.byId(rule.id))!.weather_delivery!.episodes).length,
      1,
    );
    assert.equal((await update()).deliver, false);
  } finally {
    await f.close();
  }
});

test('new profiles opt out of weather; existing owners get occasional updates by default', () => {
  assert.equal(profileNotifications().weather?.mode, 'off');
  assert.equal(profileNotifications({ owner: true } as any).weather?.mode, 'updates');
  assert.equal(
    profileNotifications({
      owner: true,
      notifications: { weather: { mode: 'off', routineIntervalHours: 12 } },
    } as any).weather?.mode,
    'off',
  );
});
