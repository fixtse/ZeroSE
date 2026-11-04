import type { WeatherChange } from './weather-change.js';

/** Retain each field's first observed value until that value is actually reported. */
export function accumulateWeather(
  pending: WeatherChange | undefined,
  incoming: WeatherChange,
  now = Date.now(),
): WeatherChange {
  const periods = new Map(
    (pending?.entity_id === incoming.entity_id &&
    JSON.stringify(pending.units) === JSON.stringify(incoming.units)
      ? pending.changes
      : []
    ).map((p) => [p.datetime, structuredClone(p)]),
  );
  for (const period of incoming.changes) {
    const old = periods.get(period.datetime);
    periods.set(
      period.datetime,
      old && old.after && period.before && period.after
        ? {
            datetime: period.datetime,
            before: { ...period.before, ...old.before },
            after: { ...old.after, ...period.after },
          }
        : structuredClone(period),
    );
  }
  const hourly = incoming.forecast_type === 'hourly';
  const changes = [...periods.values()]
    .filter((p) => {
      const at = Date.parse(p.datetime);
      return at + (hourly ? 3600_000 : 86400_000) > now && at <= now + 168 * 3600_000;
    })
    .sort((a, b) => a.datetime.localeCompare(b.datetime));
  const limit = hourly ? 48 : 12;
  return {
    ...incoming,
    changes: changes.slice(0, limit),
    truncated: incoming.truncated || changes.length > limit,
  };
}

export function reportedWeather(pending: WeatherChange, reported: WeatherChange): WeatherChange {
  if (pending.entity_id !== reported.entity_id) return pending;
  return {
    ...pending,
    changes: pending.changes.map((period) => {
      const sent = reported.changes.find((p) => p.datetime === period.datetime);
      if (!sent?.after || !period.before || !period.after) return period;
      return { ...period, before: { ...period.before, ...sent.after } };
    }),
  };
}
