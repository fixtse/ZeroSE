import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { assistantIdPattern, toolCapability, type BotId } from '../../domain/access.js';
import type { AccessRepository } from '../../application/access.js';

export interface ToolSummary {
  name: string;
  description: string;
}

/** Lists the tools a profile can use and saves which of them are hidden from the assistant. */
export class ProfileToolsAdmin {
  constructor(
    private profiles: Pick<AccessRepository, 'profile' | 'setDisabledTools'>,
    private catalog: (bot: BotId, chatId: string) => Promise<ToolSummary[]>,
  ) {}
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    const match = new RegExp(
      '^/v1/admin/profiles/(' + assistantIdPattern + ')/([^/]+)/tools$',
    ).exec(path);
    if (!match) return false;
    const bot = match[1];
    let chatId: string;
    try {
      chatId = decodeURIComponent(match[2]);
    } catch {
      send(400, { error: 'Chat ID no válido.' });
      return true;
    }
    const profile = await this.profiles.profile(bot, chatId);
    if (!profile) {
      send(404, { error: 'Perfil no encontrado.' });
      return true;
    }
    const tools = await this.catalog(bot, chatId);
    const disabled = new Set(profile.disabledTools || []);
    if (req.method === 'GET') {
      send(200, {
        tools: tools
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            capability: toolCapability(tool.name) || null,
            enabled: !disabled.has(tool.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
      return true;
    }
    if (req.method === 'PUT') {
      const input = z
        .object({ disabled: z.array(z.string().min(1).max(100)).max(500) })
        .strict()
        .parse(await read());
      const known = new Set(tools.map((tool) => tool.name));
      const unknown = input.disabled.filter((name) => !known.has(name));
      if (unknown.length) {
        send(400, { error: 'Herramientas desconocidas: ' + unknown.join(', ') });
        return true;
      }
      if (!this.profiles.setDisabledTools) {
        send(503, { error: 'No disponible.' });
        return true;
      }
      // Keep hidden tools that are temporarily unavailable (for example, a capability turned off).
      const kept = [...disabled].filter((name) => !known.has(name));
      await this.profiles.setDisabledTools(bot, chatId, [...kept, ...input.disabled]);
      send(200, { saved: true, disabled: input.disabled });
      return true;
    }
    send(405, { error: 'Método no permitido.' });
    return true;
  }
}
