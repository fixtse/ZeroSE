import { forecastFields, type WeatherChange } from './weather-change.js';
import { weatherHazards } from './weather-notifications.js';

export interface WeatherTiming {
  kind: string;
  datetime: string;
}

function kinds(period: WeatherChange['changes'][number], change: WeatherChange) {
  const result = new Set(weatherHazards(period, change).map(([kind]) => kind));
  const uv = period.after?.uv_index;
  if (typeof uv === 'number' && Number.isFinite(uv) && uv >= 6) result.add('uv');
  return result;
}

export function hasImportantWeather(change: WeatherChange) {
  return change.changes.some((period) => kinds(period, change).size > 0);
}

/** Match each reported hazard to its first upcoming hourly period on an affected local day. */
export function hourlyWeatherTimes(
  change: WeatherChange,
  hourly: unknown,
  now: Date,
  timezone: string,
): WeatherTiming[] {
  if (!hourly || typeof hourly !== 'object') return [];
  const data = hourly as {
    entity_id?: unknown;
    forecast?: unknown;
    units?: WeatherChange['units'];
  };
  if (data.entity_id !== change.entity_id || !Array.isArray(data.forecast)) return [];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  const affected = new Set(
    change.changes.flatMap((period) =>
      [...kinds(period, change)].map((kind) => day.format(new Date(period.datetime)) + ':' + kind),
    ),
  );
  const first = new Map<string, number>();
  for (const period of data.forecast.slice(0, 24)) {
    if (!period || typeof period !== 'object' || typeof period.datetime !== 'string') continue;
    const at = Date.parse(period.datetime);
    if (!Number.isFinite(at) || at < now.getTime() || at >= now.getTime() + 24 * 3600_000) continue;
    const after: NonNullable<WeatherChange['changes'][number]['after']> = {};
    for (const key of forecastFields) {
      const value = period[key];
      if (key === 'condition' && typeof value === 'string') after[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) after[key] = value;
    }
    const hourlyChange: WeatherChange = {
      ...change,
      forecast_type: 'hourly',
      units: data.units || {},
    };
    for (const kind of kinds({ datetime: period.datetime, before: null, after }, hourlyChange)) {
      if (!affected.has(day.format(new Date(at)) + ':' + kind)) continue;
      if (!first.has(kind) || at < first.get(kind)!) first.set(kind, at);
    }
  }
  return [...first]
    .sort((a, b) => a[1] - b[1])
    .map(([kind, at]) => ({
      kind,
      datetime: new Date(at).toISOString(),
    }));
}
