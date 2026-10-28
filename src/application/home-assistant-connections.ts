import { homeAssistantBinding, type ZeroSettingsPort } from './zero-settings.js';
import type { AccessRepository } from './access.js';
import type { Config } from '../domain/config.js';

/** Saved connections established by the Zero integration, never browser-supplied credentials. */
export interface HomeAssistantConnection {
  id: string;
  name: string;
  connection: Config['homeAssistant'];
}
export class HomeAssistantConnections {
  constructor(
    private settings: ZeroSettingsPort,
    private profiles: Pick<AccessRepository, 'profile'>,
  ) {}
  async list() {
    const bindings = (await this.settings.read()).homeAssistantUsers || {};
    const connections: HomeAssistantConnection[] = [];
    const urls = new Set<string>();
    for (const value of new Set(Object.values(bindings))) {
      const binding = homeAssistantBinding(value);
      if (!binding) continue;
      const profile = await this.profiles.profile(binding.bot, binding.chatId);
      const connection = profile?.pairedHomeAssistant || profile?.homeAssistant;
      if (!profile?.enabled || !connection?.url || !connection.token) continue;
      const url = connection.url.replace(/\/$/, '');
      if (urls.has(url)) continue;
      urls.add(url);
      connections.push({ id: binding.session, name: profile.label, connection });
    }
    return connections;
  }
}
