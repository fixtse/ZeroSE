import { accessProfiles } from './database-schema.js';
import type { Database } from './database.js';
import type { PostgresAccess } from './postgres-access.js';
import { sessionAddress, telegramSession } from '../../domain/access.js';
import {
  homeAssistantConnectionVersion,
  type HomeAssistantConnectionWriter,
  type HomeAssistantConnectionChanges,
} from '../../application/home-assistant-connections.js';

/** Change the source and all saved selections atomically; never contact live HA. */
export class PostgresHomeAssistantConnections implements HomeAssistantConnectionWriter {
  constructor(
    private db: Database,
    private profiles: PostgresAccess,
  ) {}
  async change(input: HomeAssistantConnectionChanges) {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ bot: accessProfiles.bot, chatId: accessProfiles.chat_id })
        .from(accessProfiles)
        .orderBy(accessProfiles.bot, accessProfiles.chat_id)
        .for('update');
      const profiles = (
        await Promise.all(rows.map((row) => this.profiles.profile(row.bot, row.chatId, tx)))
      ).filter((profile) => !!profile);
      const address = sessionAddress(input.id);
      const source =
        address &&
        profiles.find(
          (profile) => profile.bot === address.bot && profile.chatId === address.chatId,
        );
      const connection = source && (source.pairedHomeAssistant || source.homeAssistant);
      if (!connection?.token || homeAssistantConnectionVersion(connection) !== input.version)
        return false;
      const url = connection.url.replace(/\/$/, '');
      const matches = (value?: { url: string }) => value?.url.replace(/\/$/, '') === url;
      const find = (id: string) => {
        const profile = profiles.find((item) => telegramSession(item.bot, item.chatId) === id);
        return profile?.pairedHomeAssistant || profile?.homeAssistant;
      };
      for (const profile of profiles) {
        let changed = false;
        let pairedHomeAssistant = profile.pairedHomeAssistant;
        let homeAssistant = profile.homeAssistant;
        if (matches(pairedHomeAssistant)) {
          pairedHomeAssistant = input.remove
            ? undefined
            : {
                ...pairedHomeAssistant!,
                name: input.name!,
                token: input.token || pairedHomeAssistant!.token,
              };
          changed = true;
        }
        if (homeAssistant) {
          const selections = homeAssistant.connections
            ?.filter((item) => !input.remove || !matches(item))
            .map((item) => (matches(item) ? { ...item, name: input.name! } : item));
          if (homeAssistant.connections?.some(matches)) {
            homeAssistant = { ...homeAssistant, connections: selections };
            changed = true;
          }
          if (matches(homeAssistant)) {
            if (input.remove) {
              const replacement = selections?.find((item) => find(item.id)?.token);
              const next = replacement && find(replacement.id);
              homeAssistant = {
                ...homeAssistant,
                url: next?.url || '',
                token: next?.token || '',
                name: next?.name,
                activeConnectionId: replacement?.id,
              };
            } else
              homeAssistant = {
                ...homeAssistant,
                name: input.name!,
                token: input.token || homeAssistant.token,
              };
            changed = true;
          }
        }
        if (changed)
          await this.profiles.saveProfile({ ...profile, pairedHomeAssistant, homeAssistant }, tx);
      }
      return true;
    });
  }
}
