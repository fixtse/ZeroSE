import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type {
  AssistantImageGenerator,
  AssistantImageRepository,
  AssistantPhotoPort,
} from '../../application/assistant-images.js';
import type { AssistantDefinitions } from '../../application/assistant-definitions.js';

const jpeg = z
  .string()
  .max(180000)
  .refine((value) => {
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    const data = Buffer.from(value.split(',')[1], 'base64');
    return (
      data.length >= 4 &&
      data.length <= 131072 &&
      data[0] === 255 &&
      data[1] === 216 &&
      data.at(-2) === 255 &&
      data.at(-1) === 217
    );
  }, 'Usa una imagen JPEG de hasta 128 KB.');

export class AssistantImageAdmin {
  constructor(
    private definitions: AssistantDefinitions,
    private images: AssistantImageRepository,
    private telegram?: AssistantPhotoPort,
    private generator?: AssistantImageGenerator,
  ) {}
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    const match =
      /^\/v1\/admin\/setup\/assistants\/([a-z0-9][a-z0-9_-]{0,99})\/image(\/telegram|\/generate)?$/.exec(
        path,
      );
    if (!match) return false;
    const id = match[1];
    if (!(await this.definitions.get(id))) {
      send(404, { error: 'Asistente no encontrado.' });
      return true;
    }
    const remote = match[2] === '/telegram';
    if (match[2] === '/generate') {
      if (req.method !== 'POST') send(405, { error: 'Method not allowed' });
      else {
        const { prompt, references } = z
          .object({
            prompt: z.string().trim().min(1).max(2000),
            references: z.array(jpeg).max(3).default([]),
          })
          .strict()
          .parse(await read());
        if (!this.generator || !(await this.generator.available()))
          send(400, { error: 'El modelo predeterminado no permite generar imágenes.' });
        else {
          try {
            send(200, {
              image: await this.generator.generate(prompt, AbortSignal.timeout(180000), references),
            });
          } catch {
            send(502, { error: 'No se pudo generar la imagen. No se ha reintentado.' });
          }
        }
      }
      return true;
    }
    if (req.method === 'GET') {
      if (remote) {
        if (!this.telegram || !(await this.telegram.available(id))) {
          send(400, { error: 'Este asistente no tiene una conexión de Telegram configurada.' });
          return true;
        }
        send(200, { image: await this.telegram.get(id, AbortSignal.timeout(30000)) });
      } else
        send(200, {
          ...(await this.images.get(id)),
          generation: (await this.generator?.available().catch(() => false)) ?? false,
          telegram: !!this.telegram && (await this.telegram.available(id)),
        });
    } else if (req.method === 'PUT' && !remote) {
      const input = z
        .object({ image: jpeg.nullable(), revision: z.number().int().min(0) })
        .strict()
        .parse(await read());
      const saved = await this.images.save(id, input.image, input.revision);
      send(
        saved ? 200 : 409,
        saved || { error: 'La imagen ha cambiado. Recarga antes de guardarla.' },
      );
    } else if (req.method === 'POST' && remote) {
      const input = z
        .object({ image: jpeg, confirm: z.literal(true) })
        .strict()
        .parse(await read());
      if (!this.telegram || !(await this.telegram.available(id))) {
        send(400, { error: 'Este asistente no tiene una conexión de Telegram configurada.' });
        return true;
      }
      try {
        await this.telegram.set(
          id,
          Buffer.from(input.image.split(',')[1], 'base64'),
          AbortSignal.timeout(30000),
        );
        send(200, { updated: true });
      } catch {
        send(502, {
          error:
            'No se pudo confirmar el cambio en Telegram. Consulta la foto actual antes de repetirlo; no se ha reintentado.',
        });
      }
    } else send(405, { error: 'Method not allowed' });
    return true;
  }
}
