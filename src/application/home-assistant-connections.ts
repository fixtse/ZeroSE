import { createHash } from 'node:crypto';
import { telegramSession, type AccessProfile } from '../domain/access.js';
import { homeAssistantBinding, type ZeroSettingsPort } from './zero-settings.js';
import type { AccessRepository } from './access.js';
import type { Config } from '../domain/config.js';

/** Saved connections established by the Zero integration, never browser-supplied credentials. */
export interface HomeAssistantConnection {
  id: string;
  name: string;
  version?: string;
  connection: Config['homeAssistant'];
}
export function homeAssistantConnectionVersion(value: Config['homeAssistant']) {
  return createHash('sha256')
    .update(JSON.stringify([value.url.replace(/\/$/, ''), value.name || '', value.token]))
    .digest('hex');
}
export interface HomeAssistantConnectionChanges {
  id: string;
  version: string;
  name?: string;
  token?: string;
  remove?: boolean;
}
export interface HomeAssistantConnectionWriter {
  change(input: HomeAssistantConnectionChanges): Promise<boolean>;
}
export class HomeAssistantConnections {
  constructor(
    private settings: ZeroSettingsPort,
    private profiles: Pick<AccessRepository, 'profile'> &
      Partial<Pick<AccessRepository, 'profiles'>>,
    private writer?: HomeAssistantConnectionWriter,
  ) {}
  async change(input: HomeAssistantConnectionChanges) {
    if (!this.writer) throw new Error('La gestión de conexiones no está disponible.');
    return this.writer.change(input);
  }
  async list() {
    const bindings = (await this.settings.read()).homeAssistantUsers || {};
    const sources: { id: string; profile: AccessProfile }[] = [];
    const seen = new Set<string>();
    for (const value of new Set(Object.values(bindings))) {
      const binding = homeAssistantBinding(value);
      if (!binding) continue;
      const profile = await this.profiles.profile(binding.bot, binding.chatId);
      if (profile) {
        sources.push({ id: binding.session, profile });
        seen.add(binding.session);
      }
    }
    if (this.profiles.profiles) {
      for (let offset = 0; ; offset += 50) {
        const page = await this.profiles.profiles('', offset, 50);
        for (const profile of page.items) {
          const id = telegramSession(profile.bot, profile.chatId);
          if (!seen.has(id)) {
            sources.push({ id, profile });
            seen.add(id);
          }
        }
        if (!page.items.length || offset + page.items.length >= page.total) break;
      }
    }
    const connections: HomeAssistantConnection[] = [];
    const urls = new Set<string>();
    for (const { id, profile } of sources) {
      const connection = profile?.pairedHomeAssistant || profile?.homeAssistant;
      if (!profile?.enabled || !connection?.url || !connection.token) continue;
      const url = connection.url.replace(/\/$/, '');
      if (urls.has(url)) continue;
      urls.add(url);
      connections.push({
        id,
        name: connection.name || profile.label,
        version: homeAssistantConnectionVersion(connection),
        connection,
      });
    }
    return connections;
  }
}
