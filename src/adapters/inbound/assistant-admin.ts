import { assistantIdPattern } from '../../domain/access.js';
import type { AssistantTelegramAdmin } from './assistant-telegram-admin.js';
import type { AssistantImageAdmin } from './assistant-image-admin.js';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { AssistantDefinitions } from '../../application/assistant-definitions.js';
import type { AccessRepository } from '../../application/access.js';
const idSchema = z.union([z.enum(['zero', 'salem', 'standard']), z.uuid()]);
const fields = { name: z.string().trim().min(1).max(100), prompt: z.string().min(1).max(100000) };
export class AssistantAdmin {
  constructor(
    private definitions: AssistantDefinitions,
    private profiles: AccessRepository,
    private images?: AssistantImageAdmin,
    private telegram?: AssistantTelegramAdmin,
  ) {}
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    if (await this.telegram?.handle(req, path, read, send)) return true;
    if (await this.images?.handle(req, path, read, send)) return true;
    const root = '/v1/admin/setup/assistants';
    if (path === root && req.method === 'GET') {
      const query = new URL(req.url || '/', 'http://localhost').searchParams;
      const input = z
        .object({
          search: z.string().max(100).default(''),
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .parse(Object.fromEntries(query));
      send(200, {
        ...(await this.definitions.list(input.search, input.offset, input.limit)),
        offset: input.offset,
        limit: input.limit,
      });
    } else if (path === root && req.method === 'POST') {
      send(
        201,
        await this.definitions.create(
          z
            .object(fields)
            .strict()
            .parse(await read()),
        ),
      );
    } else if (path.startsWith(root + '/')) {
      const id = idSchema.parse(path.slice(root.length + 1));
      if (req.method === 'GET') {
        const value = await this.definitions.get(id);
        send(value ? 200 : 404, value || { error: 'Asistente no encontrado.' });
      } else if (req.method === 'PUT') {
        const input = z
          .object({ ...fields, revision: z.number().int().positive() })
          .strict()
          .parse(await read());
        const value = await this.definitions.update(id, input);
        send(
          value ? 200 : 409,
          value || {
            error:
              'El asistente ha cambiado. Recarga antes de guardar. El nombre de Zero se conserva.',
          },
        );
      } else if (req.method === 'DELETE') {
        const input = z
          .object({ revision: z.number().int().positive() })
          .strict()
          .parse(await read());
        const result = await this.definitions.remove(id, input.revision);
        send(
          result === 'deleted' ? 200 : 409,
          result === 'deleted'
            ? { deleted: true }
            : {
                error:
                  'No se puede eliminar un asistente integrado, asignado a un perfil o modificado desde otra sesión.',
              },
        );
      } else send(405, { error: 'Method not allowed' });
    } else {
      const match = new RegExp(
        '^/v1/admin/setup/profiles/(' + assistantIdPattern + ')/(-?\\d{1,16})/assistant$',
      ).exec(path);
      if (!match) return false;
      const bot = idSchema.parse(match[1]),
        chatId = match[2];
      const profile = await this.profiles.profile(bot, chatId);
      if (!profile) {
        send(404, { error: 'Perfil no encontrado.' });
        return true;
      }
      if (req.method === 'GET') {
        const { prompt: _, ...summary } = await this.definitions.resolve(profile, bot);
        send(200, summary);
      } else if (req.method === 'PUT') {
        const input = z
          .object({ assistantId: idSchema })
          .strict()
          .parse(await read());
        const saved = await this.definitions.assign(bot, chatId, input.assistantId);
        send(
          saved ? 200 : 409,
          saved ? { saved: true } : { error: 'El perfil o asistente ya no está disponible.' },
        );
      } else send(405, { error: 'Method not allowed' });
    }
    return true;
  }
}
