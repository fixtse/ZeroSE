interface PersonReading {
  entity_id: string;
  state: unknown;
  attributes: Record<string, unknown>;
  last_reported?: unknown;
  last_updated?: unknown;
}

/** HA observations only: report age is not a guarantee of the phone's GPS fix age. */
export function personDistance(first: PersonReading, second: PersonReading, now = Date.now()) {
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const hasCoordinates = (reading: PersonReading) => {
    const { latitude, longitude } = reading.attributes;
    return (
      finite(latitude) &&
      finite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    );
  };
  const inspect = (reading: PersonReading) => {
    const { gps_accuracy, friendly_name } = reading.attributes;
    const reported = reading.last_reported ?? reading.last_updated;
    const at = typeof reported === 'string' ? Date.parse(reported) : NaN;
    const age = (now - at) / 1000;
    const status =
      typeof reading.state !== 'string' ||
      ['', 'unknown', 'unavailable'].includes(reading.state.trim().toLowerCase())
        ? 'unavailable'
        : !hasCoordinates(reading)
          ? 'invalid_coordinates'
          : !Number.isFinite(age) || age < -30
            ? 'invalid_timestamp'
            : age > 3600
              ? 'stale'
              : gps_accuracy !== undefined &&
                  (!finite(gps_accuracy) || gps_accuracy < 0 || gps_accuracy > 200)
                ? 'inaccurate'
                : 'ok';
    return {
      entity_id: reading.entity_id,
      name: typeof friendly_name === 'string' ? friendly_name.slice(0, 200) : reading.entity_id,
      status,
      reported_at: Number.isFinite(at) ? new Date(at).toISOString() : null,
      age_seconds: Number.isFinite(age) ? Math.max(0, Math.floor(age)) : null,
      gps_accuracy_m: finite(gps_accuracy) && gps_accuracy >= 0 ? gps_accuracy : null,
    };
  };
  const locations = [inspect(first), inspect(second)];
  const available = hasCoordinates(first) && hasCoordinates(second);
  const current = available && locations.every((location) => location.status === 'ok');
  let distance: number | null = null;
  if (available) {
    const radians = (value: unknown) => ((value as number) * Math.PI) / 180;
    const lat1 = radians(first.attributes.latitude),
      lat2 = radians(second.attributes.latitude);
    const deltaLat = lat2 - lat1;
    const deltaLon = radians(second.attributes.longitude) - radians(first.attributes.longitude);
    const a =
      Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
    distance = Math.round(6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a)))));
  }
  return {
    observed_at: new Date(now).toISOString(),
    available,
    current,
    basis: 'latest_reported_coordinates',
    distance_m: distance,
    method: 'straight_line',
    locations,
    max_report_age_seconds: 3600,
    max_gps_accuracy_m: 200,
  };
}
