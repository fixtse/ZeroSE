import type { WeatherChange } from './weather-change.js';

export interface EventWeatherWindow {
  id: string;
  title: string;
  location: string;
  start: string;
  end: string;
  window_start: string;
  window_end: string;
  forecast_scope: 'home_area_not_verified_at_destination';
}

export function eventWeatherWindows(events: any[], now: Date): EventWeatherWindow[] {
  return events
    .flatMap((event) => {
      const location = String(event.location || '').trim();
      const title = String(event.summary || 'Evento');
      const remote = /https?:\/\/|\b(online|virtual|zoom|teams|videollamada|remoto)\b/i;
      const home = /^(?:en )?(?:casa|home|mi casa)$/i;
      const outdoor =
        /\b(paseo|caminar|senderismo|correr|running|ciclismo|bicicleta|excursión|aire libre)\b/i;
      const start = Date.parse(event.start?.dateTime),
        end = Date.parse(event.end?.dateTime);
      if (
        event.status === 'cancelled' ||
        event.attendees?.some(
          (person: any) => person.self && person.responseStatus === 'declined',
        ) ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end <= now.getTime() ||
        start > now.getTime() + 24 * 3600_000 ||
        remote.test(location) ||
        remote.test(title) ||
        home.test(location) ||
        /\ben casa\b/i.test(title) ||
        (!location && (event.conferenceData || !outdoor.test(title)))
      )
        return [];
      return [
        {
          id: String(event.id || '').slice(0, 200),
          title: title.slice(0, 200),
          location: location.slice(0, 300),
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          window_start: new Date(start - 30 * 60_000).toISOString(),
          window_end: new Date(end + 15 * 60_000).toISOString(),
          forecast_scope: 'home_area_not_verified_at_destination' as const,
        },
      ];
    })
    .slice(0, 20);
}

function overlaps(event: EventWeatherWindow, at: string, now: Date) {
  const start = Date.parse(at);
  return (
    Number.isFinite(start) &&
    start + 3600_000 > Math.max(Date.parse(event.window_start), now.getTime()) &&
    start < Date.parse(event.window_end)
  );
}

export function eventWeatherContext(events: any[], hourly: unknown, now: Date, timezone: string) {
  const data = hourly as
    | { forecast?: Record<string, unknown>[]; units?: WeatherChange['units'] }
    | undefined;
  const format = new Intl.DateTimeFormat('es-ES', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return eventWeatherWindows(events, now).map((event) => ({
    ...event,
    local_start: format.format(new Date(event.start)),
    local_end: format.format(new Date(event.end)),
    units: data?.units,
    forecast: (data?.forecast || [])
      .filter((period) => overlaps(event, String(period.datetime), now))
      .slice(0, 24),
  }));
}

/** Compare only supplied before/after values; missing fields never mean zero. */
export function relevantWeatherChange(
  period: WeatherChange['changes'][number],
  units: WeatherChange['units'],
) {
  if (!period.before || !period.after) return false;
  const a = period.before,
    b = period.after;
  const hazards = new Set([
    'rainy',
    'pouring',
    'lightning',
    'lightning-rainy',
    'snowy',
    'snowy-rainy',
    'hail',
    'fog',
    'windy',
    'windy-variant',
    'exceptional',
  ]);
  if (
    typeof a.condition === 'string' &&
    typeof b.condition === 'string' &&
    a.condition !== b.condition &&
    (hazards.has(a.condition) || hazards.has(b.condition))
  )
    return true;
  const changed = (
    key: string,
    convert: (v: number) => number,
    relevant: (a: number, b: number) => boolean,
  ) => {
    const before = a[key as keyof typeof a],
      after = b[key as keyof typeof b];
    return (
      typeof before === 'number' &&
      typeof after === 'number' &&
      relevant(convert(before), convert(after))
    );
  };
  const crosses = (a: number, b: number, threshold: number) => a >= threshold !== b >= threshold;
  if (
    changed(
      'precipitation_probability',
      (v) => v,
      (a, b) => Math.max(a, b) >= 40 && Math.abs(a - b) >= 20,
    )
  )
    return true;
  if (
    ['mm', 'in', 'inches'].includes(units.precipitation || '') &&
    changed(
      'precipitation',
      (v) => (units.precipitation === 'mm' ? v : v * 25.4),
      (a, b) => crosses(a, b, 0.1) || Math.abs(a - b) >= 0.5,
    )
  )
    return true;
  const wind = units.wind_speed;
  if (
    ['km/h', 'm/s', 'mph'].includes(wind || '') &&
    ['wind_speed', 'wind_gust_speed'].some((key) =>
      changed(
        key,
        (v) => v * (wind === 'm/s' ? 3.6 : wind === 'mph' ? 1.609344 : 1),
        (a, b) => crosses(a, b, 30) || (Math.max(a, b) >= 30 && Math.abs(a - b) >= 10),
      ),
    )
  )
    return true;
  if (
    ['°C', '°F'].includes(units.temperature || '') &&
    ['temperature', 'apparent_temperature'].some((key) =>
      changed(
        key,
        (v) => (units.temperature === '°F' ? ((v - 32) * 5) / 9 : v),
        (a, b) => crosses(a, b, 30) || crosses(a, b, 8) || Math.abs(a - b) >= 5,
      ),
    )
  )
    return true;
  return changed(
    'uv_index',
    (v) => v,
    (a, b) => Math.max(a, b) >= 6 && Math.abs(a - b) >= 2,
  );
}

export function eventWeatherImpacts(
  events: any[],
  change: WeatherChange,
  now: Date,
  timezone: string,
) {
  const changes = change.changes.filter((period) => relevantWeatherChange(period, change.units));
  return eventWeatherContext(events, undefined, now, timezone).flatMap((event) => {
    const affected = changes.filter((period) => overlaps(event, period.datetime, now));
    return affected.length ? [{ ...event, changes: affected }] : [];
  });
}
