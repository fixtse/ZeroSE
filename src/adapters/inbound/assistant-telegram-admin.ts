import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { assistantIdPattern } from '../../domain/access.js';
import {
  AssistantTelegram,
  TelegramConnectionConflict,
} from '../../application/assistant-telegram.js';

export class AssistantTelegramAdmin {
  constructor(private connections: AssistantTelegram) {}
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    const match = new RegExp(
      '^/v1/admin/setup/assistants/(' +
        assistantIdPattern +
        ')/telegram(?:/(status|register|remove))?$',
    ).exec(path);
    if (!match) return false;
    const id = match[1],
      action = match[2];
    try {
      if (req.method === 'GET' && !action) send(200, await this.connections.read(id));
      else if (req.method === 'GET' && action === 'status')
        send(200, await this.connections.status(id));
      else if (req.method === 'PUT' && !action) {
        const input = z
          .object({
            token: z.string().max(300).default(''),
            enabled: z.boolean(),
            transport: z.enum(['disabled', 'webhook', 'polling']),
            webhookUrl: z.string().max(2048).default(''),
            revision: z.number().int().min(0),
            clearToken: z.boolean().default(false),
          })
          .strict()
          .parse(await read());
        send(200, await this.connections.save(id, input));
      } else if (req.method === 'POST' && (action === 'register' || action === 'remove')) {
        const input = z
          .object({ confirm: z.literal(true), revision: z.number().int().min(0) })
          .strict()
          .parse(await read());
        try {
          if (action === 'register') await this.connections.register(id, input.revision);
          else await this.connections.remove(id, input.revision);
          send(200, { confirmed: true });
        } catch (error) {
          if (error instanceof TelegramConnectionConflict) throw error;
          send(502, {
            error:
              action === 'remove'
                ? 'No se pudo confirmar la desactivación completa de Telegram. Recarga la conexión y consulta su estado antes de repetir; no se ha reintentado.'
                : 'No se pudo confirmar el cambio del webhook en Telegram. Consulta el estado antes de repetirlo; no se ha reintentado.',
          });
        }
      } else send(405, { error: 'Method not allowed' });
    } catch (error) {
      send(error instanceof TelegramConnectionConflict ? 409 : 400, {
        error: error instanceof Error ? error.message : 'No se pudo guardar la conexión.',
      });
    }
    return true;
  }
}
