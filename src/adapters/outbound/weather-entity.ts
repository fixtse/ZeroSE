export function dailyWeatherEntity(states: unknown): string {
  const candidates = (Array.isArray(states) ? states : []).filter(
    (state) =>
      /^weather\.[a-z0-9_]+$/.test(state?.entity_id) &&
      (state.attributes?.supported_features & 1) !== 0,
  );
  if (candidates.length !== 1)
    throw new Error(
      'Configure homeAssistant.weatherEntity when there is not exactly one daily forecast source',
    );
  return candidates[0].entity_id;
}
