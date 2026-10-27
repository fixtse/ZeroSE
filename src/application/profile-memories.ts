import { homeAssistantBinding } from './zero-settings.js';
import type { AccessProfile } from '../domain/access.js';
import type { MemoryFragment } from '../domain/models.js';
import type { MemoryPort, MemoryRepository } from './ports.js';
import type { PersonalDataPort } from './personal-data.js';
import type { AccessRepository } from './access.js';

export interface ProfileMemoryScope {
  key: string;
  enabled: boolean;
  shared: boolean;
  linked: boolean;
  memory: MemoryPort;
}

export class ProfileMemoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function memoryProfile(
  profile: AccessProfile,
  profiles: Pick<AccessRepository, 'profile'>,
  bindings: () => Promise<Record<string, string>>,
) {
  if (profile.bot !== 'zero' || !profile.chatId.startsWith('ha:')) return profile;
  const chat = (await bindings())[profile.chatId.slice(3)];
  if (!chat) return profile;
  const binding = homeAssistantBinding(chat);
  const linked = binding && (await profiles.profile(binding.bot, binding.chatId));
  if (!linked || linked.kind !== 'user')
    throw new ProfileMemoryError(404, 'El usuario vinculado ya no está disponible.');
  return linked;
}

/** Scope comes only from the saved profile and its server-side identity bindings. */
export class ProfileMemories {
  constructor(
    private repository: Pick<MemoryRepository, 'readMemory'>,
    private data: Pick<PersonalDataPort, 'memories' | 'forget'>,
    private resolve: (profile: AccessProfile) => Promise<ProfileMemoryScope>,
  ) {}

  async list(
    profile: AccessProfile,
    search: string,
    category: string | undefined,
    offset: number,
    limit: number,
  ) {
    const scope = await this.resolve(profile);
    return {
      ...(await this.data.memories(scope.key, search, category, offset, limit, true)),
      enabled: scope.enabled,
      shared: scope.shared,
      linked: scope.linked,
    };
  }

  async read(profile: AccessProfile, id: string, offset = 0) {
    const scope = await this.resolve(profile);
    const value = await this.repository.readMemory(scope.key, id);
    if (!value) throw new ProfileMemoryError(404, 'Recuerdo no encontrado en este perfil.');
    const end = Math.min(offset + 8000, value.text.length);
    if (offset > value.text.length) throw new ProfileMemoryError(400, 'Página de texto no válida.');
    return {
      id: value.id,
      text: value.text.slice(offset, end),
      metadata: value.metadata,
      superseded_by: value.superseded_by,
      next_offset: end < value.text.length ? end : null,
      total_characters: value.text.length,
    };
  }

  async save(profile: AccessProfile, value: MemoryFragment, id?: string, signal?: AbortSignal) {
    const scope = await this.resolve(profile);
    if (!scope.enabled)
      throw new ProfileMemoryError(
        400,
        'Activa y guarda la memoria del perfil antes de añadir o corregir recuerdos.',
      );
    if (id) {
      const previous = await this.repository.readMemory(scope.key, id);
      if (!previous) throw new ProfileMemoryError(404, 'Recuerdo no encontrado en este perfil.');
      if (previous.superseded_by)
        throw new ProfileMemoryError(
          409,
          'Este recuerdo ya fue sustituido. Actualiza la lista para consultar el actual.',
        );
    }
    return scope.memory.save(
      scope.key,
      { ...value, supersedes: id ? [id] : undefined },
      undefined,
      signal,
    );
  }

  async forget(profile: AccessProfile, id: string) {
    const scope = await this.resolve(profile);
    if (!(await this.repository.readMemory(scope.key, id)))
      throw new ProfileMemoryError(404, 'Recuerdo no encontrado en este perfil.');
    return { deleted: await this.data.forget(scope.key, [id]) };
  }
}
