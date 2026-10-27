import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { assistantIdPattern } from '../../domain/access.js';
import type { AccessRepository } from '../../application/access.js';
import type { GroupMembersRepository } from '../../application/group-members.js';
import { ConfigSchema } from '../outbound/config-schema.js';

const fields = ConfigSchema.shape.homeAssistant.unwrap().shape;
const member = z
  .object({
    name: z.string().trim().min(1).max(100),
    locationEntity: fields.locationEntity,
    geocodedLocationEntity: fields.geocodedLocationEntity,
  })
  .strict();
export class GroupMembersAdmin {
  constructor(
    private profiles: Pick<AccessRepository, 'profile'>,
    private members: GroupMembersRepository,
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
        ')/(-\\d{1,16})/members(?:/([1-9]\\d{0,15}))?$',
    ).exec(path);
    if (!match) return false;
    const [, bot, chatId, userId] = match;
    const profile = await this.profiles.profile(bot, chatId);
    if (!profile || profile.kind !== 'group') {
      send(404, { error: 'Grupo no encontrado.' });
      return true;
    }
    if (userId && !Number.isSafeInteger(Number(userId))) {
      send(400, { error: 'ID de Telegram no válido.' });
      return true;
    }
    if (req.method === 'GET' && !userId) {
      const query = z
        .object({
          search: z.string().trim().max(200).default(''),
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .parse(Object.fromEntries(new URL(req.url || path, 'http://localhost').searchParams));
      send(200, await this.members.list(bot, chatId, query.search, query.offset, query.limit));
    } else if (req.method === 'GET' && userId) {
      const value = await this.members.get(bot, chatId, userId);
      send(value ? 200 : 404, value || { error: 'Integrante no encontrado.' });
    } else if (req.method === 'POST' && !userId) {
      const input = member
        .extend({
          userId: z
            .string()
            .regex(/^[1-9]\d{0,15}$/)
            .refine((value) => Number.isSafeInteger(Number(value))),
        })
        .parse(await read());
      const saved = await this.members.save(
        bot,
        chatId,
        { ...input, username: '', present: true, observed: false },
        true,
      );
      send(
        saved ? 200 : 409,
        saved
          ? { saved: true }
          : { error: 'Este integrante ya existe. Selecciónalo en la lista para editarlo.' },
      );
    } else if (req.method === 'PUT' && userId) {
      const input = member.parse(await read());
      await this.members.save(bot, chatId, {
        userId,
        ...input,
        username: '',
        present: true,
        observed: false,
      });
      send(200, { saved: true });
    } else if (req.method === 'DELETE' && userId) {
      await this.members.remove(bot, chatId, userId);
      send(200, { deleted: true });
    } else send(405, { error: 'Método no permitido.' });
    return true;
  }
}
