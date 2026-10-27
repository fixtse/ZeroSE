/** Location monitoring uses the profile's explicit entity scope, never group membership alone. */
export function permitsLocationEntity(
  config: { sensorEntities: string[]; locationEntity: string },
  entity: string,
): boolean {
  return (
    /^(person|zone)\.[a-z0-9_]+$/.test(entity) &&
    (config.sensorEntities.length === 0 ||
      config.sensorEntities.includes(entity) ||
      config.locationEntity === entity)
  );
}
