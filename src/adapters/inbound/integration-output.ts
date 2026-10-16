export function pick(value: any, fields: string[]) {
  return Object.fromEntries(
    fields.filter((field) => value?.[field] !== undefined).map((field) => [field, value[field]]),
  );
}

export function eventSummary(value: any) {
  return {
    ...pick(value, [
      'id',
      'summary',
      'start',
      'end',
      'status',
      'location',
      'htmlLink',
      'recurringEventId',
    ]),
    ...(value.description || value.attendees?.length ? { details_available: true } : {}),
  };
}

export function taskSummary(value: any) {
  return {
    ...pick(value, ['id', 'title', 'status', 'due', 'completed', 'parent', 'webViewLink']),
    ...(value.notes ? { details_available: true } : {}),
  };
}

export function sensorSummary(value: any) {
  return {
    ...pick(value, ['entity_id', 'state', 'last_changed', 'last_updated', 'last_reported']),
    ...pick(value.attributes, ['friendly_name', 'unit_of_measurement', 'device_class']),
  };
}

export function historySummary(value: any, entity: string, start: string, end: string) {
  const samples: any[] = Array.isArray(value?.[0])
    ? value.flat()
    : Array.isArray(value)
      ? value
      : [];
  let numeric = 0,
    sum = 0,
    minimum = Infinity,
    maximum = -Infinity,
    unavailable = 0;
  for (const sample of samples) {
    const state = String(sample.state ?? '').trim();
    if (['unknown', 'unavailable', ''].includes(state.toLowerCase())) unavailable++;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(state)) continue;
    const number = Number(state);
    if (!Number.isFinite(number)) continue;
    numeric++;
    sum += number;
    minimum = Math.min(minimum, number);
    maximum = Math.max(maximum, number);
  }
  return {
    entity_id: entity,
    start,
    end,
    sample_count: samples.length,
    numeric_samples: numeric,
    unavailable_samples: unavailable,
    first: samples.length ? sensorSummary(samples[0]) : null,
    last: samples.length ? sensorSummary(samples.at(-1)) : null,
    ...(numeric ? { minimum, maximum, sample_mean: sum / numeric } : {}),
    notice:
      'Statistics describe returned samples, not a time-weighted average. Use mode=raw for paginated readings.',
  };
}
