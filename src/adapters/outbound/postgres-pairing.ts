import { and, eq } from 'drizzle-orm';
import { zeroSettings, accessProfiles as profiles } from './database-schema.js';
import { type Database } from './database.js';
import type { PairingUnitOfWork } from '../../application/home-assistant-pairing.js';
import { IntegrationAccess } from '../../application/integration-access.js';
import { PostgresIntegrationAccess, credentialCrypto } from './postgres-integration-access.js';
import type { PostgresAccess } from './postgres-access.js';
import type { PostgresZeroSettings } from './postgres-zero-settings.js';
/** Profile credentials, user binding and Zero credential commit together. */
export class PostgresPairing implements PairingUnitOfWork {
  constructor(
    private db: Database,
    private profiles: PostgresAccess,
    private settings: PostgresZeroSettings,
  ) {}
  async run<T>(
    work: (ports: Parameters<Parameters<PairingUnitOfWork['run']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (client) => {
      await client
        .select({ id: zeroSettings.id })
        .from(zeroSettings)
        .where(eq(zeroSettings.id, 1))
        .for('update');
      const result = await work({
        profiles: {
          profile: async (bot, chatId) => {
            await client
              .select({ chat_id: profiles.chat_id })
              .from(profiles)
              .where(and(eq(profiles.bot, bot), eq(profiles.chat_id, chatId)))
              .for('update');
            return this.profiles.profile(bot, chatId, client);
          },
          saveProfile: (profile) => this.profiles.saveProfile(profile, client),
        },
        settings: {
          read: () => this.settings.read(client),
          update: (value) => this.settings.update(value, client),
        },
        tokens: new IntegrationAccess(new PostgresIntegrationAccess(client), credentialCrypto),
      });
      return result;
    });
  }
}
