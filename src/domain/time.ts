export function localClock(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export function dayRange(date: Date, timezone: string) {
  const day = localClock(date, timezone).day;
  function midnight(value: string) {
    const target = Date.parse(value + 'T00:00:00Z');
    let instant = target;
    for (let i = 0; i < 4; i++) {
      const local = localClock(new Date(instant), timezone);
      instant += target - Date.parse(`${local.day}T${local.time}:00Z`);
    }
    return new Date(instant).toISOString();
  }
  const tomorrow = new Date(Date.parse(day + 'T12:00:00Z') + 86400_000).toISOString().slice(0, 10);
  return { start: midnight(day), end: midnight(tomorrow) };
}

export function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
