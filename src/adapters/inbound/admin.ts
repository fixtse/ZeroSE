import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Config } from '../../domain/config.js';
import { capabilities, type AccessProfile, type BotId } from '../../domain/access.js';
import type { AccessRepository } from '../../application/access.js';
import { ConfigSchema } from '../outbound/config.js';
import { adminPage } from './admin-page.js';

const profileSchema = z.object({
  kind: z.enum(['user', 'group']),
  label: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  capabilities: z.array(z.enum(capabilities)).max(capabilities.length),
  google: ConfigSchema.shape.google.optional(),
  homeAssistant: ConfigSchema.shape.homeAssistant
    .unwrap()
    .extend({
      locationEntity: ConfigSchema.shape.homeAssistant
        .unwrap()
        .shape.locationEntity.unwrap()
        .default(''),
      geocodedLocationEntity: ConfigSchema.shape.homeAssistant
        .unwrap()
        .shape.geocodedLocationEntity.unwrap()
        .default(''),
    })
    .optional(),
  clearGoogle: z.boolean().default(false),
  clearHomeAssistant: z.boolean().default(false),
});
function publicProfile(p: AccessProfile) {
  return {
    bot: p.bot,
    chatId: p.chatId,
    kind: p.kind,
    label: p.label,
    enabled: p.enabled,
    owner: p.owner,
    capabilities: p.capabilities,
    hasGoogle: !!(
      p.google?.refreshToken ||
      Object.values(p.google?.credentials || {}).some((c) => !!c?.refreshToken)
    ),
    hasHomeAssistant: !!p.homeAssistant?.token,
    google: p.google
      ? {
          clientId: p.google.clientId,
          calendarId: p.google.calendarId,
          taskListId: p.google.taskListId,
          contextDocumentId: p.google.contextDocumentId,
          documentFolderId: p.google.documentFolderId,
        }
      : undefined,
    homeAssistant: p.homeAssistant ? { ...p.homeAssistant, token: undefined } : undefined,
  };
}
export class Admin {
  constructor(
    private config: Config,
    private repository: AccessRepository,
    private validateToken: (token: string) => Promise<void>,
  ) {}
  page(res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
    });
    res.end(adminPage);
  }
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<any>,
    send: (status: number, value: unknown) => void,
  ): Promise<boolean> {
    if (!path.startsWith('/v1/admin/')) return false;
    if (req.method === 'GET' && path === '/v1/admin/bots') {
      const settings = await this.repository.bots();
      send(200, {
        items: [
          {
            id: 'zero',
            configured: !!this.config.telegram.token,
            enabled: this.config.telegram.transport !== 'disabled',
          },
          {
            id: 'salem',
            configured: settings.some((b) => b.id === 'salem' && !!b.token),
            enabled: settings.some((b) => b.id === 'salem' && b.enabled),
          },
        ],
      });
      return true;
    }
    if (req.method === 'PUT' && path === '/v1/admin/bots/salem') {
      const input = z
        .object({ token: z.string().max(300).default(''), enabled: z.boolean() })
        .parse(await read());
      const previous = (await this.repository.bots()).find((b) => b.id === 'salem');
      const token = input.token.trim() || previous?.token || '';
      if (input.enabled && !token) {
        send(400, { error: 'Introduce el token de Salem antes de activarlo.' });
        return true;
      }
      if (token && token.split(':')[0] === this.config.telegram.token.split(':')[0]) {
        send(400, { error: 'Salem debe usar un bot distinto de Zero.' });
        return true;
      }
      if (input.token.trim()) {
        if (!/^\d+:[\w-]+$/.test(token)) {
          send(400, { error: 'El formato del token de Telegram no es válido.' });
          return true;
        }
        try {
          await this.validateToken(token);
        } catch {
          send(400, { error: 'Telegram no pudo validar el token. Compruébalo antes de guardar.' });
          return true;
        }
      }
      await this.repository.saveBot({ id: 'salem', token, enabled: input.enabled });
      send(200, { saved: true });
      return true;
    }
    if (req.method === 'GET' && path === '/v1/admin/profiles') {
      const query = new URL(req.url || '/', 'http://localhost').searchParams;
      const search = z
        .string()
        .max(200)
        .parse(query.get('search') || '');
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .parse(query.get('offset') || 0);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .parse(query.get('limit') || 20);
      const result = await this.repository.profiles(
        search,
        offset,
        limit,
        query.get('pending') === 'true',
      );
      send(200, { items: result.items.map(publicProfile), total: result.total, offset, limit });
      return true;
    }
    const match = /^\/v1\/admin\/profiles\/(zero|salem)\/(-?\d{1,16})$/.exec(path);
    if (match) {
      const bot = match[1] as BotId,
        chatId = match[2];
      const previous = await this.repository.profile(bot, chatId);
      if (req.method === 'GET') {
        send(
          previous ? 200 : 404,
          previous ? publicProfile(previous) : { error: 'Chat no encontrado.' },
        );
        return true;
      }
      if (req.method === 'PUT') {
        const input = profileSchema.parse(await read());
        if (
          !Number.isSafeInteger(Number(chatId)) ||
          (input.kind === 'group' ? Number(chatId) >= 0 : Number(chatId) <= 0)
        ) {
          send(400, {
            error: 'El chat ID debe ser positivo para usuarios y negativo para grupos.',
          });
          return true;
        }
        if (previous && previous.kind !== input.kind) {
          send(400, { error: 'El tipo de un chat existente no puede cambiar.' });
          return true;
        }
        const previousGoogle =
          previous?.google || (previous?.owner ? this.config.google : undefined);
        const previousHA =
          previous?.homeAssistant || (previous?.owner ? this.config.homeAssistant : undefined);
        let google = previous?.google;
        if (input.clearGoogle) google = ConfigSchema.parse({}).google;
        else if (input.google) {
          google = {
            ...input.google,
            clientId: input.google.clientId || previousGoogle?.clientId || '',
            calendarId: input.google.calendarId || 'primary',
            taskListId: input.google.taskListId || '@default',
            clientSecret: input.google.clientSecret || previousGoogle?.clientSecret || '',
            refreshToken: input.google.refreshToken || previousGoogle?.refreshToken || '',
            credentials: Object.keys(input.google.credentials).length
              ? input.google.credentials
              : previousGoogle?.credentials || {},
          };
        }
        let homeAssistant = previous?.homeAssistant;
        if (input.clearHomeAssistant)
          homeAssistant = { ...ConfigSchema.parse({}).homeAssistant, token: '' };
        else if (input.homeAssistant)
          homeAssistant = {
            ...input.homeAssistant,
            token: input.homeAssistant.token || previousHA?.token || '',
          };
        await this.repository.saveProfile({
          bot,
          chatId,
          kind: input.kind,
          label: input.label,
          enabled: input.enabled,
          capabilities: [...new Set(input.capabilities)],
          owner: previous?.owner || false,
          google,
          homeAssistant,
        });
        send(200, { saved: true });
        return true;
      }
    }
    send(404, { error: 'Not found' });
    return true;
  }
}
