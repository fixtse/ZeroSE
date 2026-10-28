import type { HomeAssistantConnections } from '../../application/home-assistant-connections.js';
import type { GoogleDestinations } from '../../application/google-destinations.js';
import { AIAdmin, modelPermissionsSchema } from './ai-admin.js';
import type { ProfileMemoryAdmin } from './profile-memory-admin.js';
import type { UserContext } from '../../application/user-context.js';
import { secretHint } from '../../application/secret-hint.js';
import type { IncomingMessage } from 'node:http';
import type { GroupMembersAdmin } from './group-members-admin.js';
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
import { ConfigSchema } from '../outbound/config-schema.js';
import type {
  GoogleDestinationFactory,
  GoogleDestinationKind,
  AdminCatalogFactory,
} from '../../application/admin-catalog.js';
import type { RuleRepository } from '../../application/notification-rules.js';
import { defaultAssistantId } from '../../domain/assistant-definition.js';

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
  ...modelPermissionsSchema,
  kind: z.enum(['user', 'group']),
  label: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  voiceReplies: z.boolean().optional(),
  respondToReplies: z.boolean().optional(),
  speech: speechSchema.optional(),
  memoryPolicy: z.enum(['automatic', 'explicit']).optional(),
  capabilities: z.array(z.enum(capabilities)).max(capabilities.length),
  memoryMode: z.enum(memoryModes).optional(),
  timezone: z.string().trim().min(1).max(100).refine(validTimezone).optional(),
  google: ConfigSchema.shape.google.unwrap().optional(),
  homeAssistant: ConfigSchema.shape.homeAssistant
    .unwrap()
    .omit({ connections: true, activeConnectionId: true })
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
  useConfiguredHomeAssistant: z.boolean().default(false),
  homeAssistantConnectionIds: z.array(z.string().min(1).max(250)).max(20).optional(),
  activeHomeAssistantConnectionId: z.string().min(1).max(250).optional(),
});
function publicProfile(
  p: AccessProfile,
  timezone: string,
  ownerHA?: Config['homeAssistant'],
  ownerGoogle?: Config['google'],
) {
  const homeAssistant = p.homeAssistant || (p.owner ? ownerHA : undefined);
  const google = p.google || (p.owner ? ownerGoogle : undefined);
  return {
    bot: p.bot,
    chatId: p.chatId,
    kind: p.kind,
    label: p.label,
    enabled: p.enabled,
    voiceReplies: p.voiceReplies !== false,
    respondToReplies: p.respondToReplies !== false,
    speech: p.speech || {
      stt: 'default',
      sttLanguage: 'es-ES',
      tts: 'default',
      ttsLanguage: 'es-ES',
      voice: '',
    },
    assistantId: defaultAssistantId(p, p.bot),
    memoryPolicy: p.memoryPolicy || 'automatic',
    owner: p.owner,
    context: p.context || '',
    contextRevision: p.contextRevision || 0,
    source: p.chatId.startsWith('ha:') ? 'home_assistant' : 'telegram',
    defaultModel: p.defaultModel || '',
    alternateModels: p.alternateModels || [],
    memoryMode: p.memoryMode || 'advanced',
    timezone: p.timezone || timezone,
    capabilities: p.capabilities,
    hasGoogle: !!(
      p.google?.refreshToken ||
      Object.values(p.google?.credentials || {}).some((c) => !!c?.refreshToken)
    ),
    hasHomeAssistant: !!homeAssistant?.token,
    google: google
      ? {
          clientId: google.clientId,
          clientSecretHint: secretHint(google.clientSecret),
          refreshTokenHint: google.refreshToken ? '•••••••• (configurado)' : '',
          destinationNames: google.destinationNames,
          calendarId: google.calendarId,
          taskListId: google.taskListId,
          contextDocumentId: google.contextDocumentId,
          documentFolderId: google.documentFolderId,
          credentials: Object.fromEntries(
            Object.entries(google.credentials || {}).map(([key, value]) => [
              key,
              {
                clientId: value?.clientId || '',
                clientSecretHint: secretHint(value?.clientSecret),
                refreshTokenHint: value?.refreshToken ? '•••••••• (configurado)' : '',
                configured: !!value?.refreshToken,
              },
            ]),
          ),
        }
      : undefined,
    homeAssistant: homeAssistant
      ? { ...homeAssistant, token: undefined, tokenHint: secretHint(homeAssistant.token) }
      : undefined,
  };
}
export class Admin {
  private googleDestinationSettings?: GoogleDestinations;
  withGoogleDestinations(settings: GoogleDestinations) {
    this.googleDestinationSettings = settings;
    return this;
  }

  private homeAssistantConnections?: Pick<HomeAssistantConnections, 'list'>;
  withHomeAssistantConnections(connections: Pick<HomeAssistantConnections, 'list'>) {
    this.homeAssistantConnections = connections;
    return this;
  }

  private configuredHomeAssistant?: () => Promise<Config['homeAssistant']>;

  withHomeAssistantConnection(connection: () => Promise<Config['homeAssistant']>) {
    this.configuredHomeAssistant = connection;
    return this;
  }

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
    private profilePhoto?: (bot: BotId, chatId: string) => Promise<string | undefined>,
    private userContext?: UserContext,
    private discoverUsers?: () => Promise<void>,
    private ai?: AIAdmin,
    private googleDestinations?: GoogleDestinationFactory,
    private profileMemory?: ProfileMemoryAdmin,
    private groupMembers?: GroupMembersAdmin,
  ) {}
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<any>,
    send: (status: number, value: unknown) => void,
  ): Promise<boolean> {
    if (!path.startsWith('/v1/admin/')) return false;
    if (await this.groupMembers?.handle(req, path, read, send)) return true;

    if (req.method === 'GET' && path === '/v1/admin/home-assistant/connections') {
      const params = new URL(req.url || '/', 'http://localhost').searchParams;
      const query = z.object({
        search: z.string().max(200).default(''),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }).parse(Object.fromEntries(params));
      const connections = (await this.homeAssistantConnections?.list() || [])
        .filter((item) => (item.name + ' ' + item.connection.url).toLowerCase().includes(query.search.toLowerCase()));
      send(200, {
        items: connections.slice(query.offset, query.offset + query.limit).map((item) => ({
          id: item.id, name: item.name, url: item.connection.url,
        })),
        total: connections.length,
        next_offset: query.offset + query.limit < connections.length ? query.offset + query.limit : null,
      });
      return true;
    }

    if (req.method === 'GET' && path === '/v1/admin/home-assistant/connection') {
      const connection = (await this.configuredHomeAssistant?.()) || this.config.homeAssistant;
      send(200, { available: !!(connection.url && connection.token) });
      return true;
    }

    if (await this.profileMemory?.handle(req, path, read, send)) return true;

    if (await this.ai?.handle(req, path, read, send)) return true;
    if (req.method === 'GET' && path === '/v1/admin/profiles') {
      let discoveryWarning: string | undefined;
      try {
        await this.discoverUsers?.();
      } catch {
        discoveryWarning =
          'No se pudieron descubrir los usuarios de Home Assistant. Se muestran los perfiles guardados.';
      }
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
        discoveryWarning,
        schedules: {
          enabled: this.config.schedules.enabled,
          reset: this.config.schedules.reset,
        },
        items: result.items.map((profile) =>
          publicProfile(
            profile,
            this.config.timezone,
            this.config.homeAssistant,
            this.config.google,
          ),
        ),
        total: result.total,
        offset,
        limit,
      });
      return true;
    }
    const destinationMatch = new RegExp(
      '^/v1/admin/profiles/(' +
        assistantIdPattern +
        ')/(-?\\d{1,16}|ha:[a-f0-9]{32})/google/destination$',
    ).exec(path);
    if (destinationMatch && req.method === 'PUT') {
      const input = z
        .object({
          kind: z.enum(['calendars', 'task-lists', 'document-folders']),
          id: z.string().max(2048),
        })
        .strict()
        .parse(await read());
      if (!this.googleDestinationSettings) {
        send(503, { error: 'Selector Google no disponible.' });
        return true;
      }
      try {
        const result = await this.googleDestinationSettings.save(
          destinationMatch[1] as BotId,
          destinationMatch[2],
          input.kind,
          input.id,
        );
        send(
          result.status,
          result.error ? { error: result.error } : { saved: true, selected: result.selected },
        );
      } catch {
        send(502, {
          error:
            'No se pudo verificar ni guardar el destino. Recarga las opciones y comprueba sus permisos.',
        });
      }
      return true;
    }
    const googleMatch = new RegExp(
      '^/v1/admin/profiles/(' +
        assistantIdPattern +
        ')/(-?\\d{1,16}|ha:[a-f0-9]{32})/google/(calendars|task-lists|document-folders)$',
    ).exec(path);
    if (googleMatch && req.method === 'GET') {
      const profile = await this.repository.profile(googleMatch[1] as BotId, googleMatch[2]);
      if (!profile) {
        send(404, { error: 'Perfil no encontrado.' });
        return true;
      }
      const params = new URL(req.url || '/', 'http://localhost').searchParams;
      const query = z
        .object({
          search: z.string().max(200).default(''),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          pageToken: z.string().max(4096).default(''),
        })
        .parse(Object.fromEntries(params));
      if (!this.googleDestinations) {
        send(503, { error: 'Selector Google no disponible.' });
        return true;
      }
      try {
        send(
          200,
          await this.googleDestinations(scopedConfig(this.config, profile)).destinations(
            googleMatch[3] as GoogleDestinationKind,
            query,
            AbortSignal.timeout(10000),
          ),
        );
      } catch {
        send(502, {
          error:
            'No se pudo consultar Google. Guarda la conexión y comprueba sus permisos. Las carpetas usan la conexión de Drive.',
        });
      }
      return true;
    }
    const catalogMatch = new RegExp(
      '^/v1/admin/profiles/(' +
        assistantIdPattern +
        ')/(-?\\d{1,16}|ha:[a-f0-9]{32})/(rules|entities|services)$',
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
          domains: z
            .string()
            .regex(/^[a-z_]+(?:,[a-z_]+)*$/)
            .max(200)
            .optional(),
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
      '^/v1/admin/profiles/(' +
        assistantIdPattern +
        ')/(-?\\d{1,16}|ha:[a-f0-9]{32})/speech/(catalog|preview)$',
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
    const photoMatch = new RegExp(
      '^/v1/admin/profiles/(' + assistantIdPattern + ')/(-?\\d{1,16}|ha:[a-f0-9]{32})/photo$',
    ).exec(path);
    if (req.method === 'GET' && photoMatch) {
      const bot = photoMatch[1] as BotId,
        chatId = photoMatch[2];
      const profile = await this.repository.profile(bot, chatId);
      if (!profile) send(404, { error: 'Chat no encontrado.' });
      else {
        try {
          send(200, {
            image: await this.profilePhoto?.(bot, chatId),
          });
        } catch {
          send(200, { image: undefined });
        }
      }
      return true;
    }
    const contextMatch = new RegExp(
      '^/v1/admin/profiles/(' + assistantIdPattern + ')/(-?\\d{1,16}|ha:[a-f0-9]{32})/context$',
    ).exec(path);
    if (contextMatch && req.method === 'PUT') {
      if (!this.userContext) {
        send(503, { error: 'Context unavailable' });
        return true;
      }
      const input = z
        .object({ memory: z.string().max(16000), revision: z.number().int().min(0) })
        .strict()
        .parse(await read());
      try {
        send(
          200,
          await this.userContext.save(
            telegramSession(contextMatch[1], contextMatch[2]),
            input.memory,
            'replace',
            input.revision,
            false,
          ),
        );
      } catch (error) {
        send(409, { error: error instanceof Error ? error.message : 'Context could not be saved' });
      }
      return true;
    }
    const match = new RegExp(
      '^/v1/admin/profiles/(' + assistantIdPattern + ')/(-?\\d{1,16}|ha:[a-f0-9]{32})$',
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
        if (this.commands && previous.enabled && !chatId.startsWith('ha:')) {
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
            ? publicProfile(
                previous,
                this.config.timezone,
                this.config.homeAssistant,
                this.config.google,
              )
            : { error: 'Chat no encontrado.' },
        );
        return true;
      }
      if (req.method === 'PUT') {
        const input = profileSchema.parse(await read());
        await this.ai?.validateModels(input.defaultModel, input.alternateModels);
        if (
          !chatId.startsWith('ha:') &&
          (!Number.isSafeInteger(Number(chatId)) ||
            (input.kind === 'group' ? Number(chatId) >= 0 : Number(chatId) <= 0))
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
        if (
          chatId.startsWith('ha:') &&
!previous
        ) {
          send(400, {
            error: 'Home Assistant users must already exist before editing their connection.',
          });
          return true;
        }
        const previousGoogle =
          previous?.google || (previous?.owner ? this.config.google : undefined);
        const previousHA =
          previous?.homeAssistant || (previous?.owner ? this.config.homeAssistant : undefined);
        let configuredHA: Config['homeAssistant'] | undefined;
        if (input.useConfiguredHomeAssistant) {
          if (
            input.kind !== 'group' ||
            input.clearHomeAssistant ||
            !input.capabilities.includes('homeAssistant')
          ) {
            send(400, {
              error:
                'Activa el permiso Home Assistant del grupo para usar su conexión configurada.',
            });
            return true;
          }
          configuredHA = (await this.configuredHomeAssistant?.()) || this.config.homeAssistant;
          if (!configuredHA.url || !configuredHA.token) {
            send(400, { error: 'No hay una conexión Home Assistant configurada.' });
            return true;
          }
        }
        let selectedConnections: { id: string; name: string; url: string }[] | undefined;
        if (input.homeAssistantConnectionIds !== undefined) {
          const ids = [...new Set(input.homeAssistantConnectionIds)];
          selectedConnections = [];
          if (ids.length) {
            if (input.clearHomeAssistant) {
              send(400, { error: 'No se puede borrar y seleccionar una conexión a la vez.' });
              return true;
            }
            const connections = await this.homeAssistantConnections?.list() || [];
            const selected = ids.map((id) => connections.find((item) => item.id === id));
            const active = selected.find((item) => item?.id === input.activeHomeAssistantConnectionId);
            if (selected.some((item) => !item) || !active) {
              send(400, { error: 'Selecciona conexiones disponibles y un servidor activo.' });
              return true;
            }
            configuredHA = active.connection;
            selectedConnections = selected.map((item) => ({ id: item!.id, name: item!.name, url: item!.connection.url }));
          }
        }
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
          provider === 'home_assistant' &&
          !input.clearHomeAssistant &&
          (!(input.homeAssistant?.taskListEntity ?? previousHA?.taskListEntity) ||
            !(configuredHA?.token || input.homeAssistant?.token || previousHA?.token) ||
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
        else if (input.homeAssistant || configuredHA)
          homeAssistant = {
            ...ConfigSchema.parse({}).homeAssistant,
            ...previousHA,
            ...input.homeAssistant,
            url: configuredHA?.url || input.homeAssistant?.url || previousHA?.url || '',
            token: configuredHA?.token || input.homeAssistant?.token || previousHA?.token || '',
          };
        if (homeAssistant && selectedConnections !== undefined) {
          homeAssistant.connections = selectedConnections;
          homeAssistant.activeConnectionId = selectedConnections.length ? input.activeHomeAssistantConnectionId : undefined;
        }
        const profile: AccessProfile = {
          bot,
          chatId,
          kind: input.kind,
          label: input.label,
          enabled: input.enabled,
          voiceReplies: input.voiceReplies ?? previous?.voiceReplies ?? true,
          respondToReplies: input.respondToReplies ?? previous?.respondToReplies ?? true,
          speech: input.speech ?? previous?.speech,
          memoryPolicy: input.memoryPolicy ?? previous?.memoryPolicy,
          assistantId: previous?.assistantId,
          capabilities: [...new Set(input.capabilities)],
          owner: previous?.owner || false,
          defaultModel:
            input.defaultModel === undefined
              ? previous?.defaultModel
              : input.defaultModel || undefined,
          alternateModels: input.alternateModels ?? previous?.alternateModels ?? [],
          memoryMode: input.memoryMode ?? previous?.memoryMode ?? 'advanced',
          timezone: input.timezone ?? previous?.timezone ?? this.config.timezone,
          google,
          homeAssistant,
          pairedHomeAssistant: previous?.pairedHomeAssistant ||
            (await this.homeAssistantConnections?.list())?.find((item) => item.id === telegramSession(bot, chatId))?.connection,
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
        if (this.commands && !chatId.startsWith('ha:') && (profile.enabled || previous?.enabled)) {
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
