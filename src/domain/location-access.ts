/** "self" is resolved only from the private profile's saved location, never from a guessed identity. */
export function resolvePersonReference(entity: string, ownEntity?: string) {
  if (entity !== 'self') return entity;
  if (!ownEntity || !/^(person|device_tracker)\.[a-z0-9_]+$/.test(ownEntity))
    throw new Error(
      'Configura una entidad person o device_tracker con GPS como ubicación en tu perfil para usar «mi ubicación» en alertas.',
    );
  return ownEntity;
}
