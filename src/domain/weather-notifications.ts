import type { WeatherChange } from './weather-change.js';

export interface WeatherPreferences {
  mode: 'off' | 'important' | 'updates' | 'all';
  routineIntervalHours: number;
}
export interface WeatherDeliveryState {
  entity?: string;
  routineAt?: string;
  episodes: Record<string, { severity: number; onset?: string; end?: string; expires: string }>;
}
type Period = WeatherChange['changes'][number];

const severe = new Map([
  ['lightning', 'storm'],
  ['lightning-rainy', 'storm'],
  ['hail', 'hail'],
  ['snowy', 'snow'],
  ['snowy-rainy', 'snow'],
  ['fog', 'fog'],
  ['windy', 'wind'],
  ['windy-variant', 'wind'],
  ['exceptional', 'exceptional'],
]);
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const celsius = (value: unknown, units: WeatherChange['units']) => {
  const n = number(value);
  return n === undefined
    ? undefined
    : units.temperature === '°C'
      ? n
      : units.temperature === '°F'
        ? ((n - 32) * 5) / 9
        : undefined;
};
const wind = (value: unknown, units: WeatherChange['units']) => {
  const n = number(value);
  return n === undefined
    ? undefined
    : units.wind_speed === 'km/h'
      ? n
      : units.wind_speed === 'm/s'
        ? n * 3.6
        : units.wind_speed === 'mph'
          ? n * 1.609344
          : undefined;
};
export function weatherHazards(period: Period, change: WeatherChange) {
  const after = period.after;
  if (!after) return [];
  const result: [string, number][] = [];
  const condition = String(after.condition || '');
  const kind = severe.get(condition);
  if (kind) result.push([kind, 1]);
  const raw = number(after.precipitation);
  const rain =
    raw === undefined
      ? undefined
      : change.units.precipitation === 'mm'
        ? raw
        : ['in', 'inches'].includes(change.units.precipitation || '')
          ? raw * 25.4
          : undefined;
  const probability = number(after.precipitation_probability);
  if (
    ['rainy', 'pouring', 'lightning-rainy', 'snowy-rainy'].includes(condition) ||
    (rain !== undefined && rain >= 0.1) ||
    (probability !== undefined && probability >= 40)
  ) {
    const hourly = change.forecast_type === 'hourly';
    const severity =
      condition === 'pouring' || (rain !== undefined && rain >= (hourly ? 10 : 30))
        ? 3
        : rain !== undefined && rain >= (hourly ? 2 : 10)
          ? 2
          : 1;
    result.push(['rain', severity]);
  }
  const speed = Math.max(
    wind(after.wind_speed, change.units) || 0,
    wind(after.wind_gust_speed, change.units) || 0,
  );
  if (speed >= 50) result.push(['wind', speed >= 75 ? 3 : 2]);
  const temperature = celsius(after.apparent_temperature ?? after.temperature, change.units);
  if (temperature !== undefined && temperature >= 35)
    result.push(['heat', temperature >= 40 ? 2 : 1]);
  if (temperature !== undefined && temperature <= 0)
    result.push(['frost', temperature <= -5 ? 2 : 1]);
  return result;
}
function routine(period: Period, change: WeatherChange) {
  if (!period.before || !period.after) return false;
  if (
    ['temperature', 'templow', 'apparent_temperature'].some((key) => {
      const a = celsius(period.before![key as keyof typeof period.before], change.units);
      const b = celsius(period.after![key as keyof typeof period.after], change.units);
      return a !== undefined && b !== undefined && Math.abs(b - a) >= 3;
    })
  )
    return true;
  if (
    weatherHazards({ ...period, after: period.before }, change).length &&
    !weatherHazards(period, change).length
  )
    return true;
  const before = number(period.before.uv_index),
    after = number(period.after.uv_index);
  return (
    before !== undefined &&
    after !== undefined &&
    [6, 8, 11].some((threshold) => before >= threshold !== after >= threshold)
  );
}

/** Shared daily/hourly delivery history, advanced only after a successful send. */
export function selectWeatherNotification(
  change: WeatherChange,
  preferences: WeatherPreferences,
  history: WeatherDeliveryState | undefined,
  now: Date,
  timezone: string,
): { change: WeatherChange; state: WeatherDeliveryState; reason: string } {
  const episodes = Object.fromEntries(
    Object.entries(
      history?.entity && history.entity !== change.entity_id ? {} : history?.episodes || {},
    ).filter(([, value]) => Date.parse(value.expires) > now.getTime()),
  );
  const state: WeatherDeliveryState = {
    entity: change.entity_id,
    routineAt: history?.routineAt,
    episodes: structuredClone(episodes),
  };
  const upcoming = change.changes.filter((period) => {
    const at = Date.parse(period.datetime);
    return (
      period.after &&
      (!period.before ||
        Object.keys({ ...period.before, ...period.after }).some(
          (key) =>
            period.before![key as keyof typeof period.before] !==
            period.after![key as keyof typeof period.after],
        )) &&
      at + (change.forecast_type === 'hourly' ? 3600_000 : 86400_000) > now.getTime() &&
      at < now.getTime() + 24 * 3600_000
    );
  });
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const observed = new Map<
    string,
    { severity: number; onset?: string; end?: string; expires: string; periods: Period[] }
  >();
  for (const period of upcoming) {
    const at = Date.parse(period.datetime);
    for (const [kind, severity] of weatherHazards(period, change)) {
      const key = `${format.format(new Date(at))}:${kind}`;
      const old = observed.get(key);
      observed.set(key, {
        severity: Math.max(old?.severity || 0, severity),
        onset:
          change.forecast_type === 'hourly'
            ? old?.onset && Date.parse(old.onset) < at
              ? old.onset
              : period.datetime
            : undefined,
        end:
          change.forecast_type === 'hourly'
            ? new Date(Math.max(old?.end ? Date.parse(old.end) : 0, at + 3600_000)).toISOString()
            : undefined,
        expires: new Date(
          Math.max(old ? Date.parse(old.expires) : 0, at + 48 * 3600_000),
        ).toISOString(),
        periods: [...(old?.periods || []), period],
      });
    }
  }
  const important = new Set<Period>();
  for (const [key, episode] of observed) {
    const previous = episodes[key];
    const earlier =
      previous?.onset &&
      episode.onset &&
      Date.parse(previous.onset) - Date.parse(episode.onset) >= 3600_000;
    const imminent =
      previous &&
      !previous.onset &&
      episode.onset &&
      Date.parse(episode.onset) <= now.getTime() + 6 * 3600_000;
    const extended =
      previous?.end &&
      episode.end &&
      Date.parse(episode.end) - Date.parse(previous.end) >= 3 * 3600_000;
    const nextEpisode =
      previous?.end &&
      episode.onset &&
      Date.parse(episode.onset) - Date.parse(previous.end) >= 2 * 3600_000;
    if (
      !previous ||
      episode.severity > previous.severity ||
      earlier ||
      imminent ||
      extended ||
      nextEpisode
    ) {
      for (const period of episode.periods) important.add(period);
      state.episodes[key] = {
        severity: Math.max(previous?.severity || 0, episode.severity),
        onset:
          !nextEpisode &&
          previous?.onset &&
          (!episode.onset || Date.parse(previous.onset) < Date.parse(episode.onset))
            ? previous.onset
            : episode.onset,
        end:
          previous?.end && (!episode.end || Date.parse(previous.end) > Date.parse(episode.end))
            ? previous.end
            : episode.end,
        expires: episode.expires,
      };
    }
  }
  const interval =
    Number.isInteger(preferences.routineIntervalHours) &&
    preferences.routineIntervalHours >= 1 &&
    preferences.routineIntervalHours <= 24
      ? preferences.routineIntervalHours
      : 6;
  const routineDue =
    !history?.routineAt || now.getTime() - Date.parse(history.routineAt) >= interval * 3600_000;
  const changes =
    preferences.mode === 'off'
      ? []
      : upcoming.filter(
          (period) =>
            important.has(period) ||
            preferences.mode === 'all' ||
            (preferences.mode === 'updates' && routineDue && routine(period, change)),
        );
  if (changes.some((period) => !important.has(period))) state.routineAt = now.toISOString();
  // Bound history even if forecast providers repeatedly introduce new periods.
  state.episodes = Object.fromEntries(Object.entries(state.episodes).slice(-100));
  return {
    change: { ...change, changes },
    state,
    reason:
      preferences.mode === 'off'
        ? 'weather_disabled'
        : important.size
          ? 'important_weather'
          : changes.length
            ? 'routine_weather'
            : 'weather_suppressed',
  };
}
