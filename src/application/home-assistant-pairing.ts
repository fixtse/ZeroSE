import { telegramSession } from '../domain/access.js';
import type { AccessRepository } from './access.js';
import type { ZeroSettingsPort } from './zero-settings.js';
import type { IntegrationAccess, CredentialCrypto } from './integration-access.js';
import type { Config } from '../domain/config.js';
export interface PairingUnitOfWork {
  run<T>(
    work: (ports: {
      profiles: Pick<AccessRepository, 'profile' | 'saveProfile'>;
      settings: ZeroSettingsPort;
      tokens: IntegrationAccess;
    }) => Promise<T>,
  ): Promise<T>;
}
interface Pairing {
  id: string;
  secretDigest: string;
  homeAssistantUrl: string;
  callback: string;
  userId: string;
  expiresAt: number;
  profile?: string;
  profileBot?: string;
  state: 'pending' | 'approved' | 'exchanging';
}
/** Short-lived, bounded handshakes. Browser approval never exposes either bearer token. */
export class HomeAssistantPairing {
  private pending = new Map<string, Pairing>();
  constructor(
    private profiles: AccessRepository,
    private transaction: PairingUnitOfWork,
    private crypto: CredentialCrypto,
    private defaults: Config['homeAssistant'],
    private publicUrl: string,
    private now = () => Date.now(),
  ) {}
  begin(input: {
    secret: string;
    homeAssistantUrl: string;
    flowId: string;
    state: string;
    userId: string;
  }) {
    const url = new URL(input.homeAssistantUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Invalid Home Assistant origin');
    for (const [id, value] of this.pending)
      if (value.expiresAt <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 100) throw new Error('Too many pending pairings');
    const id = this.crypto.id();
    const pairing: Pairing = {
      id,
      secretDigest: this.crypto.digest(input.secret),
      homeAssistantUrl: url.origin,
      callback:
        url.origin +
        '/api/assistant_zero/pairing/' +
        encodeURIComponent(input.flowId) +
        '?state=' +
        encodeURIComponent(input.state),
      userId: input.userId,
      expiresAt: this.now() + 600000,
      state: 'pending',
    };
    this.pending.set(id, pairing);
    return {
      id,
      approvalUrl: this.publicUrl + '/admin/?pairing=' + id,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
    };
  }
  private get(id: string) {
    const value = this.pending.get(id);
    if (!value || value.expiresAt <= this.now())
      throw new Error('Pairing expired. Start again from Home Assistant.');
    return value;
  }
  details(id: string) {
    const value = this.get(id);
    return {
      id: value.id,
      homeAssistantUrl: value.homeAssistantUrl,
      userId: value.userId,
      expiresAt: new Date(value.expiresAt).toISOString(),
      state: value.state,
    };
  }
  async approve(id: string, chatId: string, bot = 'zero') {
    const pairing = this.get(id);
    if (pairing.state !== 'pending') throw new Error('Pairing already approved');
    const profile = await this.profiles.profile(bot, chatId);
    if (!profile?.enabled || !['user', 'group'].includes(profile.kind))
      throw new Error('Choose an enabled user or group');
    pairing.profile = chatId;
    pairing.profileBot = bot;
    pairing.state = 'approved';
    return { redirectUrl: pairing.callback };
  }
  async exchange(id: string, secret: string, homeAssistantToken: string) {
    const pairing = this.get(id);
    if (
      pairing.secretDigest !== this.crypto.digest(secret) ||
      pairing.state !== 'approved' ||
      !pairing.profile
    )
      throw new Error('Pairing not approved or already consumed');
    pairing.state = 'exchanging'; // Lock before the first await. Never replay uncertain writes.
    const result = await this.transaction.run(
      async ({ profiles, settings: repository, tokens }) => {
        const profile = await profiles.profile(pairing.profileBot || 'zero', pairing.profile!);
        if (!profile?.enabled || !['user', 'group'].includes(profile.kind))
          throw new Error('Profile unavailable');
        const settings = await repository.read();
        const credential = await tokens.issue(
          ('Home Assistant ' + pairing.homeAssistantUrl).slice(0, 100),
          3650,
        );
        await profiles.saveProfile({
          ...profile,
          pairedHomeAssistant: {
            ...this.defaults,
            url: pairing.homeAssistantUrl,
            token: homeAssistantToken,
          },
          capabilities:
            profile.kind === 'user'
              ? [...new Set([...profile.capabilities, 'homeAssistant' as const])]
              : profile.capabilities,
          homeAssistant: {
            ...(profile.kind === 'group'
              ? {
                  url: '',
                  token: '',
                  shoppingListEntity: '',
                  sensorEntities: [],
                  weatherEntity: '',
                  locationEntity: '',
                  geocodedLocationEntity: '',
                }
              : this.defaults),
            ...profile.homeAssistant,
            url: pairing.homeAssistantUrl,
            token: homeAssistantToken,
          },
        });
        if (profile.kind === 'user') {
          const homeAssistantProfile = await profiles.profile('zero', 'ha:' + pairing.userId);
          if (homeAssistantProfile && profile.bot === 'zero')
            await profiles.saveProfile({
              ...homeAssistantProfile,
              capabilities: [
                ...new Set([...homeAssistantProfile.capabilities, 'homeAssistant' as const]),
              ],
              homeAssistant: {
                ...this.defaults,
                ...homeAssistantProfile.homeAssistant,
                url: pairing.homeAssistantUrl,
                token: homeAssistantToken,
              },
            });
          const saved = await repository.update({
            ...settings,
            homeAssistantUsers: {
              ...settings.homeAssistantUsers,
              [pairing.userId]:
                profile.bot === 'zero'
                  ? pairing.profile!
                  : telegramSession(profile.bot, pairing.profile!),
            },
          });
          if (!saved) throw new Error('Settings changed during pairing');
        }
        return {
          token: credential.token,
          settings_token: credential.token,
          callback_token: credential.token,
          callback_url: this.publicUrl + '/v1/triggers/rule-events',
          credential_id: credential.id,
        };
      },
    );
    this.pending.delete(id);
    return result;
  }
}
