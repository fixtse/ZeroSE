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

/** "self" is resolved only from the private profile's saved location, never from a guessed identity. */
export function resolvePersonReference(entity: string, ownEntity?: string) {
  if (entity !== 'self') return entity;
  if (!ownEntity || !/^person\.[a-z0-9_]+$/.test(ownEntity))
    throw new Error(
      'Configura una entidad person como ubicación en tu perfil para usar «mi ubicación» en alertas.',
    );
  return ownEntity;
}
