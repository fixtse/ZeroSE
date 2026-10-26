import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { validTimezone } from '../../domain/time.js';
import { memoryModes } from '../../domain/memory.js';
import type { Config } from '../../domain/config.js';
import {
  telegramSession,
  assistantIdPattern,
  capabilities,
  type AccessProfile,
  type BotId,
} from '../../domain/access.js';
import type {
  AccessRepository,
  ChatCommandsControl,
  WebhookControl,
} from '../../application/access.js';
import { scopedConfig } from '../../application/access.js';
import type { SpeechPort } from '../../application/ports.js';
import { ConfigSchema } from '../outbound/config.js';
import type { AdminCatalogFactory } from '../../application/admin-catalog.js';
import type { RuleRepository } from '../../application/notification-rules.js';
import { defaultAssistantId } from '../../domain/assistant-definition.js';
import { adminPage } from './admin-page.js';

const speechSchema = z.object({
  stt: z
    .string()
    .regex(/^(default|[a-z0-9_.]+)$/)
    .max(200),
  sttLanguage: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
  tts: z
    .string()
    .regex(/^(default|[a-z0-9_.]+)$/)
    .max(200),
  ttsLanguage: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
  voice: z.string().max(200),
});
const profileSchema = z.object({
  kind: z.enum(['user', 'group']),
  label: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  voiceReplies: z.boolean().optional(),
  speech: speechSchema.optional(),
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
  confirmTaskProviderChange: z.boolean().default(false),
  clearGoogle: z.boolean().default(false),
  clearHomeAssistant: z.boolean().default(false),
});
function publicProfile(p: AccessProfile, timezone: string, ownerHA?: Config['homeAssistant']) {
  const homeAssistant = p.homeAssistant || (p.owner ? ownerHA : undefined);
  return {
    bot: p.bot,
    chatId: p.chatId,
    kind: p.kind,
    label: p.label,
    enabled: p.enabled,
    voiceReplies: p.voiceReplies !== false,
    speech: p.speech || {
      stt: 'default',
      sttLanguage: 'es-ES',
      tts: 'default',
      ttsLanguage: 'es-ES',
      voice: '',
    },
    assistantId: defaultAssistantId(p, p.bot),
    promptPreset: p.promptPreset || (p.bot === 'salem' ? 'salem' : 'standard'),
    owner: p.owner,
    memoryMode: p.memoryMode || 'advanced',
    timezone: p.timezone || timezone,
    capabilities: p.capabilities,
    hasGoogle: !!(
      p.google?.refreshToken ||
      Object.values(p.google?.credentials || {}).some((c) => !!c?.refreshToken)
    ),
    hasHomeAssistant: !!homeAssistant?.token,
    google: p.google
      ? {
          clientId: p.google.clientId,
          calendarId: p.google.calendarId,
          taskListId: p.google.taskListId,
          contextDocumentId: p.google.contextDocumentId,
          documentFolderId: p.google.documentFolderId,
          credentials: Object.fromEntries(
            Object.entries(p.google.credentials || {}).map(([key, value]) => [
              key,
              {
                clientId: value?.clientId || '',
                configured: !!value?.refreshToken,
              },
            ]),
          ),
        }
      : undefined,
    homeAssistant: homeAssistant ? { ...homeAssistant, token: undefined } : undefined,
  };
}
export class Admin {
  constructor(
    private config: Config,
    private repository: AccessRepository,
    _validateToken: (token: string) => Promise<void>,
    _webhooks?: WebhookControl,
    private commands?: ChatCommandsControl,
    private speech?: (config: Config) => SpeechPort,
    private previewSpeech?: (config: Config, text: string, signal: AbortSignal) => Promise<Buffer>,
    private catalogs?: AdminCatalogFactory,
    private rules?: RuleRepository,
  ) {}
  page(res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'same-origin',
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
        items: result.items.map((profile) =>
          publicProfile(profile, this.config.timezone, this.config.homeAssistant),
        ),
        total: result.total,
        offset,
        limit,
      });
      return true;
    }
    const catalogMatch = new RegExp(
      '^/v1/admin/profiles/(' + assistantIdPattern + ')/(-?\\d{1,16})/(rules|entities|services)$',
    ).exec(path);
    if (catalogMatch && req.method === 'GET') {
      const profile = await this.repository.profile(catalogMatch[1] as BotId, catalogMatch[2]);
      if (!profile) {
        send(404, { error: 'Chat no encontrado.' });
        return true;
      }
      const params = new URL(req.url || '/', 'http://localhost').searchParams;
      const query = z
        .object({
          search: z.string().max(200).default(''),
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .parse(Object.fromEntries(params));
      if (catalogMatch[3] === 'rules') {
        if (!this.rules) send(503, { error: 'Catálogo de alertas no disponible.' });
        else {
          const kind = z
            .enum(['alert', 'reminder', 'timer'])
            .optional()
            .parse(params.get('kind') || undefined);
          const result = await this.rules.list(
            telegramSession(profile.bot, profile.chatId),
            kind,
            query.offset,
            query.limit,
          );
          send(200, {
            ...result,
            items: result.items.map((rule) => ({
              id: rule.id,
              kind: rule.kind,
              message: rule.message,
              status: rule.status,
              condition: rule.condition,
              next_at: rule.next_at,
              wake_date: rule.wake_date,
              last_fired: rule.last_fired,
              scheduler_state: rule.scheduler_state,
              repeat_seconds: rule.repeat_seconds,
              recurring: rule.recurring,
              cooldown_seconds: rule.cooldown_seconds,
            })),
          });
        }
        return true;
      }
      const scoped = scopedConfig(this.config, profile);
      if (!this.catalogs || !scoped.homeAssistant.token) {
        send(400, { error: 'Activa Home Assistant y guarda su conexión para este chat.' });
        return true;
      }
      try {
        const catalog = this.catalogs(scoped),
          signal = AbortSignal.timeout(10000);
        send(
          200,
          await (catalogMatch[3] === 'entities'
            ? catalog.entities(query, signal)
            : catalog.services(query, signal)),
        );
      } catch {
        send(502, {
          error: 'No se pudo consultar Home Assistant. Comprueba la conexión guardada.',
        });
      }
      return true;
    }
    const speechMatch = new RegExp(
      '^/v1/admin/profiles/(' + assistantIdPattern + ')/(-?\\d{1,16})/speech/(catalog|preview)$',
    ).exec(path);
    if (speechMatch && req.method === 'POST') {
      const profile = await this.repository.profile(speechMatch[1] as BotId, speechMatch[2]);
      if (!profile) {
        send(404, { error: 'Guarda primero el chat y su conexión Home Assistant.' });
        return true;
      }
      const scoped = scopedConfig(this.config, profile);
      const signal = AbortSignal.timeout(60_000);
      try {
        if (speechMatch[3] === 'preview') {
          const input = z
            .object({ speech: speechSchema, text: z.string().trim().min(1).max(1000) })
            .parse(await read());
          if (input.speech.tts !== 'default' && !scoped.homeAssistant.token) {
            send(400, { error: 'Activa Home Assistant y guarda su conexión para este chat.' });
            return true;
          }
          if (!this.previewSpeech) throw new Error('Speech preview unavailable');
          scoped.media = { ...scoped.media, speech: input.speech };
          const audio = await this.previewSpeech(scoped, input.text, signal);
          send(200, { audio: audio.toString('base64'), mime: 'audio/ogg' });
        } else {
          const input = z
            .object({
              kind: z.enum(['stt', 'tts', 'voices']),
              engine: speechSchema.shape.tts.optional(),
              language: speechSchema.shape.ttsLanguage.default('es-ES'),
              search: z.string().max(200).default(''),
              offset: z.number().int().min(0).max(100000).default(0),
              limit: z.number().int().min(1).max(100).default(50),
            })
            .parse(await read());
          if (!this.speech || !scoped.homeAssistant.token) {
            send(400, { error: 'Activa Home Assistant y guarda su conexión para este chat.' });
            return true;
          }
          const speech = this.speech(scoped);
          send(
            200,
            input.kind === 'voices'
              ? await speech.voices(
                  z.string().min(1).parse(input.engine),
                  input.language,
                  input,
                  signal,
                )
              : await speech.engines(input.kind, input, signal),
          );
        }
      } catch (error) {
        if (error instanceof z.ZodError) throw error;
        send(502, {
          error:
            'No se pudo completar la solicitud de voz. Comprueba la conexión, el motor, el idioma y la voz. No se ha reintentado.',
        });
      }
      return true;
    }
    const match = new RegExp(
      '^/v1/admin/profiles/(' + assistantIdPattern + ')/(-?\\d{1,16})$',
    ).exec(path);
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
            ? publicProfile(previous, this.config.timezone, this.config.homeAssistant)
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
            credentials: { ...previousGoogle?.credentials },
          };
        }
        if (!input.clearGoogle && input.google && google) {
          for (const service of ['calendar', 'tasks', 'docs', 'drive'] as const) {
            const value = input.google.credentials[service];
            if (!value) continue;
            const saved = previousGoogle?.credentials[service];
            google.credentials[service] = {
              clientId: value.clientId || saved?.clientId || '',
              clientSecret: value.clientSecret || saved?.clientSecret || '',
              refreshToken: value.refreshToken || saved?.refreshToken || '',
            };
          }
        }
        const provider = input.homeAssistant?.taskProvider || previousHA?.taskProvider || 'google';
        if (
          provider !== (previousHA?.taskProvider || 'google') &&
          !input.confirmTaskProviderChange
        ) {
          send(400, { error: 'Confirma el cambio de proveedor de tareas.' });
          return true;
        }
        if (
          provider === 'home_assistant' &&
          !input.clearHomeAssistant &&
          (!(input.homeAssistant?.taskListEntity ?? previousHA?.taskListEntity) ||
            !(input.homeAssistant?.token || previousHA?.token) ||
            !input.capabilities.includes('homeAssistant'))
        ) {
          send(400, {
            error: 'Selecciona una lista to-do y una conexión Home Assistant con permiso.',
          });
          return true;
        }
        let homeAssistant = previous?.homeAssistant;
        if (input.clearHomeAssistant)
          homeAssistant = {
            ...ConfigSchema.parse({}).homeAssistant,
            token: '',
            taskProvider: provider,
            taskListEntity: input.homeAssistant?.taskListEntity ?? previousHA?.taskListEntity,
          };
        else if (input.homeAssistant)
          homeAssistant = {
            ...previousHA,
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
          speech: input.speech ?? previous?.speech,
          promptPreset: input.promptPreset ?? previous?.promptPreset,
          assistantId:
            input.promptPreset &&
            input.promptPreset !==
              (previous?.promptPreset || (bot === 'salem' ? 'salem' : 'standard'))
              ? undefined
              : previous?.assistantId,
          capabilities: [...new Set(input.capabilities)],
          owner: previous?.owner || false,
          memoryMode: input.memoryMode ?? previous?.memoryMode ?? 'advanced',
          timezone: input.timezone ?? previous?.timezone ?? this.config.timezone,
          google,
          homeAssistant,
        };
        if (
          profile.speech &&
          (profile.speech.stt !== 'default' || profile.speech.tts !== 'default') &&
          !scopedConfig(this.config, profile).homeAssistant.token
        ) {
          send(400, {
            error:
              'Activa Home Assistant y configura su conexión antes de seleccionar sus motores de voz.',
          });
          return true;
        }
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
