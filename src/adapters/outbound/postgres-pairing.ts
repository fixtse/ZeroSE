import type pg from 'pg';
import type { PairingUnitOfWork } from '../../application/home-assistant-pairing.js';
import { IntegrationAccess } from '../../application/integration-access.js';
import { PostgresIntegrationAccess, credentialCrypto } from './postgres-integration-access.js';
import type { PostgresAccess } from './postgres-access.js';
import type { PostgresZeroSettings } from './postgres-zero-settings.js';
/** Profile credentials, user binding and Zero credential commit together. */
export class PostgresPairing implements PairingUnitOfWork {
  constructor(
    private pool: pg.Pool,
    private profiles: PostgresAccess,
    private settings: PostgresZeroSettings,
  ) {}
  async run<T>(
    work: (ports: Parameters<Parameters<PairingUnitOfWork['run']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM zero_settings WHERE id=1 FOR UPDATE');
      const result = await work({
        profiles: {
          profile: async (bot, chatId) => {
            await client.query(
              'SELECT chat_id FROM access_profiles WHERE bot=$1 AND chat_id=$2 FOR UPDATE',
              [bot, chatId],
            );
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
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
