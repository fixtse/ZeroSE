import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { assistantIdPattern } from '../../domain/access.js';
import type { AccessRepository } from '../../application/access.js';
import { ProfileMemories, ProfileMemoryError } from '../../application/profile-memories.js';

const fragment = z
  .object({
    text: z.string().trim().min(1).max(16000),
    category: z.string().trim().min(1).max(200),
    tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    expiresAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .refine(
        (value) => !value || Date.parse(value) > Date.now(),
        'La caducidad debe ser una fecha futura.',
      ),
    entities: z.array(z.string().trim().min(2).max(120)).max(48).optional(),
    relations: z
      .array(
        z
          .object({
            subject: z.string().trim().min(2).max(120),
            predicate: z.string().trim().min(1).max(120),
            object: z.string().trim().min(2).max(120),
          })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .strict();

export class ProfileMemoryAdmin {
  constructor(
    private profiles: Pick<AccessRepository, 'profile'>,
    private memories: ProfileMemories,
  ) {}
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    const match = new RegExp(
      '^/v1/admin/profiles/(' +
        assistantIdPattern +
        ')/(-?\\d{1,16}|ha:[a-f0-9]{32})/memories(?:/([1-9]\\d{0,18}))?$',
    ).exec(path);
    if (!match) return false;
    const profile = await this.profiles.profile(match[1], match[2]);
    if (!profile) {
      send(404, { error: 'Perfil no encontrado.' });
      return true;
    }
    const id = match[3];
    if (id && BigInt(id) > 9223372036854775807n) {
      send(400, { error: 'Identificador de recuerdo no válido.' });
      return true;
    }
    const query = new URL(req.url || path, 'http://localhost').searchParams;
    try {
      if (req.method === 'GET') {
        if (id)
          send(
            200,
            await this.memories.read(
              profile,
              id,
              z.coerce
                .number()
                .int()
                .min(0)
                .max(10000000)
                .default(0)
                .parse(query.get('text_offset') ?? undefined),
            ),
          );
        else {
          const params = z
            .object({
              search: z.string().trim().max(300).default(''),
              category: z.string().trim().max(200).optional(),
              offset: z.coerce.number().int().min(0).max(10000000).default(0),
              limit: z.coerce.number().int().min(1).max(50).default(20),
            })
            .parse(Object.fromEntries(query));
          send(
            200,
            await this.memories.list(
              profile,
              params.search,
              params.category || undefined,
              params.offset,
              params.limit,
            ),
          );
        }
      } else if ((req.method === 'POST' && !id) || (req.method === 'PUT' && id)) {
        const input = fragment.parse(await read());
        send(200, await this.memories.save(profile, input, id, AbortSignal.timeout(30000)));
      } else if (req.method === 'DELETE' && id) send(200, await this.memories.forget(profile, id));
      else send(405, { error: 'Método no permitido.' });
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      if (error instanceof ProfileMemoryError) send(error.status, { error: error.message });
      else
        send(502, {
          error:
            'No se pudo confirmar la operación de memoria. No se ha reintentado. Actualiza la lista antes de realizar otro cambio.',
        });
    }
    return true;
  }
}
