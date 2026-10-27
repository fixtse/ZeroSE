import { personDistance } from '../domain/location-distance.js';

/** Use the same scoped, membership-checked reader as location_get. */
export async function groupDistance(
  group: { location(userId: string, signal: AbortSignal): Promise<unknown> },
  first: string,
  second: string,
  signal: AbortSignal,
) {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const reading = (value: unknown) => {
    const observation = object(value);
    const sources = [object(observation.tracker), object(observation.geocoded)];
    const source =
      sources.find((source) => {
        const coordinates = object(source.coordinates);
        return (
          typeof coordinates.latitude === 'number' && typeof coordinates.longitude === 'number'
        );
      }) ??
      sources.find((source) => typeof source.entity_id === 'string') ??
      {};
    const coordinates = object(source.coordinates);
    return {
      entity_id: typeof source.entity_id === 'string' ? source.entity_id : 'unconfigured',
      state: source.available === true ? source.state : 'unavailable',
      last_reported: source.last_reported,
      last_updated: source.last_updated,
      attributes: {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        gps_accuracy: coordinates.accuracy_m,
      },
    };
  };
  const observations = await Promise.all([
    group.location(first, signal),
    group.location(second, signal),
  ]);
  const result = personDistance(reading(observations[0]), reading(observations[1]));
  return {
    ...result,
    locations: result.locations.map((location, index) => ({
      ...location,
      user_id: index === 0 ? first : second,
    })),
  };
}
