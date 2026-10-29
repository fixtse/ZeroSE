import { sessionAddress } from '../domain/access.js';
import type { Config } from '../domain/config.js';
import type { AccessRepository } from './access.js';

/** A private user's explicit declaration assigns their own location, without tracker matching. */
export class PersonalLocation {
  constructor(
    private profiles: Pick<AccessRepository, 'profile' | 'saveProfile'>,
    private defaults: Config['homeAssistant'],
  ) {}
  async assign(session: string, entity: string) {
    if (!/^person\.[a-z0-9_]+$/.test(entity)) throw new Error('Indica una entidad person válida.');
    const address = sessionAddress(session);
    const profile = address && (await this.profiles.profile(address.bot, address.chatId));
    if (
      !profile?.enabled ||
      profile.kind !== 'user' ||
      !profile.capabilities.includes('homeAssistant')
    )
      throw new Error(
        'La ubicación propia solo se puede configurar desde un perfil privado autorizado.',
      );
    const homeAssistant = profile.homeAssistant || (profile.owner ? this.defaults : undefined);
    if (!homeAssistant?.token || !homeAssistant.url)
      throw new Error('Configura primero la conexión de Home Assistant.');
    await this.profiles.saveProfile({
      ...profile,
      homeAssistant: { ...homeAssistant, locationEntity: entity },
    });
    return { saved: true, entity_id: entity };
  }
}
