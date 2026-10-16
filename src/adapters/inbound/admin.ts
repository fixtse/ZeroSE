import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { validTimezone } from '../../domain/time.js';
import { memoryModes } from '../../domain/memory.js';
import { randomBytes } from 'node:crypto';
import type { Config } from '../../domain/config.js';
import {
  capabilities,
  type AccessProfile,
  type BotId,
  type BotSettings,
} from '../../domain/access.js';
import type {
  AccessRepository,
  ChatCommandsControl,
  WebhookControl,
} from '../../application/access.js';
import { ConfigSchema } from '../outbound/config.js';
import { adminPage } from './admin-page.js';

const profileSchema = z.object({
  kind: z.enum(['user', 'group']),
  label: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  voiceReplies: z.boolean().optional(),
  promptPreset: z.enum(['salem', 'standard']).optional(),
  capabilities: z.array(z.enum(capabilities)).max(capabilities.length),
  memoryMode: z.enum(memoryModes).optional(),
  timezone: z.string().trim().min(1).max(100).refine(validTimezone).optional(),
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
function publicProfile(p: AccessProfile, timezone: string) {
  return {
    bot: p.bot,
    chatId: p.chatId,
    kind: p.kind,
    label: p.label,
    enabled: p.enabled,
    voiceReplies: p.voiceReplies !== false,
    promptPreset: p.promptPreset || (p.bot === 'salem' ? 'salem' : 'standard'),
    owner: p.owner,
    memoryMode: p.memoryMode || 'advanced',
    timezone: p.timezone || timezone,
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
    private webhooks?: WebhookControl,
    private commands?: ChatCommandsControl,
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
            transport: 'webhook',
            webhookUrl: settings.find((b) => b.id === 'salem')?.webhookUrl || '',
            configured: settings.some((b) => b.id === 'salem' && !!b.token),
            enabled: settings.some((b) => b.id === 'salem' && b.enabled),
          },
        ],
      });
      return true;
    }
    if (req.method === 'GET' && path === '/v1/admin/bots/salem/webhook') {
      const settings = (await this.repository.bots()).find((b) => b.id === 'salem');
      if (!settings?.token || !this.webhooks) {
        send(400, { error: 'Configura primero el token de Salem.' });
        return true;
      }
      try {
        const status = await this.webhooks.status(settings);
        send(200, {
          ...status,
          expectedUrl: settings.webhookUrl || '',
          registered: !!settings.webhookUrl && status.url === settings.webhookUrl,
        });
      } catch {
        send(502, { error: 'No se pudo consultar el webhook en Telegram.' });
      }
      return true;
    }
    if (req.method === 'PUT' && path === '/v1/admin/bots/salem') {
      const input = z
        .object({
          token: z.string().max(300).default(''),
          enabled: z.boolean(),
          webhookUrl: z.string().max(2048).optional(),
        })
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
      const webhookUrl = input.webhookUrl?.trim() || previous?.webhookUrl || '';
      if (input.enabled && !webhookUrl) {
        send(400, { error: 'Introduce la URL HTTPS pública del webhook de Salem.' });
        return true;
      }
      if (webhookUrl) {
        let url: URL;
        try {
          url = new URL(webhookUrl);
        } catch {
          send(400, { error: 'La URL del webhook no es válida.' });
          return true;
        }
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== '/telegram/salem/webhook'
        ) {
          send(400, {
            error:
              'Usa una URL HTTPS pública que termine en /telegram/salem/webhook, sin credenciales ni parámetros.',
          });
          return true;
        }
      }
      const sameAccount = previous?.token.split(':')[0] === token.split(':')[0];
      const settings: BotSettings = {
        id: 'salem',
        token,
        enabled: input.enabled,
        webhookUrl,
        webhookSecret:
          sameAccount && previous?.webhookSecret
            ? previous.webhookSecret
            : randomBytes(32).toString('hex'),
      };
      // Persist first so Telegram can authenticate immediately after setWebhook succeeds.
      await this.repository.saveBot(settings);
      if (input.enabled) {
        try {
          if (!this.webhooks) throw new Error('Webhook control is unavailable');
          await this.webhooks.configure(settings);
        } catch {
          send(502, {
            saved: true,
            error:
              'Configuración guardada, pero no se pudo confirmar el registro del webhook. Comprueba su estado antes de volver a registrar; no se ha reintentado automáticamente.',
          });
          return true;
        }
      }
      send(200, { saved: true, webhookRegistered: input.enabled });
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
      send(200, {
        timezone: this.config.timezone,
        schedules: {
          enabled: this.config.schedules.enabled,
          reset: this.config.schedules.reset,
          consolidate: this.config.schedules.consolidate,
        },
        items: result.items.map((profile) => publicProfile(profile, this.config.timezone)),
        total: result.total,
        offset,
        limit,
      });
      return true;
    }
    const match = /^\/v1\/admin\/profiles\/(zero|salem)\/(-?\d{1,16})$/.exec(path);
    if (match) {
      const bot = match[1] as BotId,
        chatId = match[2];
      const previous = await this.repository.profile(bot, chatId);
      if (req.method === 'DELETE') {
        if (!previous) {
          send(404, { error: 'Chat no encontrado.' });
          return true;
        }
        await this.repository.removeProfile(bot, chatId);
        let warning: string | undefined;
        if (this.commands && previous.enabled) {
          try {
            await this.commands.configure({ ...previous, enabled: false });
          } catch {
            warning =
              'Chat eliminado. No se pudo confirmar que se vaciara su menú de Telegram; no se ha reintentado automáticamente.';
          }
        }
        send(200, { deleted: true, ...(warning ? { warning } : {}) });
        return true;
      }
      if (req.method === 'GET') {
        send(
          previous ? 200 : 404,
          previous
            ? publicProfile(previous, this.config.timezone)
            : { error: 'Chat no encontrado.' },
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
        const profile: AccessProfile = {
          bot,
          chatId,
          kind: input.kind,
          label: input.label,
          enabled: input.enabled,
          voiceReplies: input.voiceReplies ?? previous?.voiceReplies ?? true,
          promptPreset: input.promptPreset ?? previous?.promptPreset,
          capabilities: [...new Set(input.capabilities)],
          owner: previous?.owner || false,
          memoryMode: input.memoryMode ?? previous?.memoryMode ?? 'advanced',
          timezone: input.timezone ?? previous?.timezone ?? this.config.timezone,
          google,
          homeAssistant,
        };
        await this.repository.saveProfile(profile);
        if (this.commands && (profile.enabled || previous?.enabled)) {
          try {
            await this.commands.configure(profile);
          } catch {
            send(502, {
              saved: true,
              error:
                'Permisos guardados, pero no se pudo confirmar la actualización del menú de comandos de Telegram. No se ha reintentado automáticamente. Puedes volver a guardar el chat para actualizar el menú.',
            });
            return true;
          }
        }
        send(200, { saved: true });
        return true;
      }
    }
    send(404, { error: 'Not found' });
    return true;
  }
}
