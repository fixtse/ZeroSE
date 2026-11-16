import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { ServiceConfig, ServiceSettingsPort } from '../../application/service-settings.js';
import type { SpeechQuery, SpeechPage, SpeechVoice } from '../../domain/speech.js';
import { secretHint } from '../../application/secret-hint.js';
import { ServiceConfigSchema } from '../outbound/config-schema.js';

const defaults = ServiceConfigSchema.parse({});
const template = {
  ...defaults,
  media: {
    ...defaults.media,
    speech: { stt: 'default', sttLanguage: '', tts: 'default', ttsLanguage: '', voice: '' },
  },
};
function flatten(value: object, prefix = ''): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const path = prefix ? prefix + '.' + key : key;
      return item && typeof item === 'object' && !Array.isArray(item)
        ? Object.entries(flatten(item, path))
        : [[path, item]];
    }),
  );
}
// User/assistant connections and AI selection have dedicated editors. Keep persisted
// legacy values private and untouched when saving unrelated infrastructure settings.
const dedicatedGroups = new Set([
  'memory',
  'codex',
  'telegram',
  'google',
  'homeAssistant',
  'setup',
]);
const fields = Object.entries(flatten(template)).map(([path, value]) => ({
  path,
  group: path.split('.')[0],
  readOnly: path === 'memory.embeddingDimensions',
  type: /(?:apiKey|token|Secret|refreshToken|clientId|sharedProfile)$/i.test(path)
    ? 'secret'
    : Array.isArray(value)
      ? 'list'
      : typeof value,
}));
export class ServiceSettingsAdmin {
  constructor(
    private settings: ServiceSettingsPort,
    private apply?: (value: ServiceConfig) => Promise<void>,
    private speechCatalog?: (
      kind: 'languages' | 'voices',
      language: string,
      query: SpeechQuery,
      signal: AbortSignal,
    ) => Promise<SpeechPage<SpeechVoice>>,
    private serverConnectionUrl: () => string = () => '',
  ) {}
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    if (path === '/v1/admin/setup/services/speech' && req.method === 'GET') {
      const params = new URL(req.url || '/', 'http://localhost').searchParams;
      const query = z
        .object({
          kind: z.enum(['languages', 'voices']).default('voices'),
          language: z.string().max(100).default(''),
          search: z.string().max(200).default(''),
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .parse(Object.fromEntries(params));
      if (!this.speechCatalog) send(503, { error: 'Catálogo de voces no disponible.' });
      else
        try {
          const page = await this.speechCatalog(
            query.kind,
            query.language,
            query,
            AbortSignal.timeout(15000),
          );
          send(200, {
            ...page,
            next_offset:
              query.offset + page.items.length < page.total
                ? query.offset + page.items.length
                : null,
          });
        } catch {
          send(502, {
            error:
              'No se pudo consultar Edge TTS. Conserva la voz guardada o vuelve a consultar el catálogo.',
          });
        }
      return true;
    }
    if (path === '/v1/admin/setup/onboarding') {
      await this.onboarding(req, read, send);
      return true;
    }
    if (path !== '/v1/admin/setup/services') return false;
    const editableFields = fields.filter(
      (field) => !dedicatedGroups.has(field.group) && field.path !== 'reader.url',
    );
    if (req.method === 'GET') {
      const current = await this.settings.read();
      const values = flatten(current.value);
      send(200, {
        revision: current.revision,
        restartRequired: false,
        fields: editableFields.map((field) => ({
          ...field,
          value:
            field.type === 'secret'
              ? ''
              : field.path === 'connectionUrl'
                ? values[field.path] || this.serverConnectionUrl()
                : (values[field.path] ?? flatten(template)[field.path]),
          inherited:
            field.path === 'connectionUrl' && !values[field.path] && !!this.serverConnectionUrl(),
          secretHint:
            field.type === 'secret'
              ? secretHint(values[field.path] as string | undefined)
              : undefined,
          configured: field.type === 'secret' && !!values[field.path],
        })),
      });
    } else if (req.method === 'PUT') {
      const input = z
        .object({
          revision: z.number().int().positive(),
          changes: z.record(z.string(), z.unknown()),
        })
        .strict()
        .parse(await read());
      const current = await this.settings.read();
      if (current.revision !== input.revision) {
        send(409, { error: 'La configuración ha cambiado. Recarga antes de guardar.' });
        return true;
      }
      const value = structuredClone(current.value) as Record<string, any>;
      if (Object.keys(input.changes).some((path) => path.startsWith('media.speech.'))) {
        value.media.speech = { ...template.media.speech, ...value.media.speech };
      }
      for (const [path, next] of Object.entries(input.changes)) {
        const field = editableFields.find((field) => field.path === path);
        if (field?.readOnly) {
          send(400, {
            error: 'Las dimensiones de memoria requieren una migración de base de datos.',
          });
          return true;
        }
        if (!field) {
          send(400, { error: 'Campo de servicio desconocido.' });
          return true;
        }
        // Empty password inputs preserve secrets; null explicitly clears them.
        if (field.type === 'secret' && next === '') continue;
        const parts = path.split('.');
        let target = value;
        for (const part of parts.slice(0, -1)) target = target[part] ??= {};
        target[parts.at(-1)!] = next === null && field.type === 'secret' ? '' : next;
      }
      const parsed = ServiceConfigSchema.safeParse(value);
      if (!parsed.success) {
        send(400, {
          error: 'Configuración inválida.',
          fields: parsed.error.issues.map((issue) => issue.path.join('.')),
        });
        return true;
      }
      if (Object.hasOwn(input.changes, 'imageSearch.defaultProvider')) {
        const images = parsed.data.imageSearch;
        const configured =
          images.defaultProvider === 'brave'
            ? parsed.data.braveApiKey
            : images.defaultProvider === 'searchapi'
              ? images.searchApiKey
              : images.serpApiKey;
        if (!configured) {
          send(400, {
            error: 'Configura la clave del proveedor de imágenes seleccionado.',
            fields: ['imageSearch.defaultProvider'],
          });
          return true;
        }
      }
      try {
        new Intl.DateTimeFormat('en', { timeZone: parsed.data.timezone });
      } catch {
        send(400, { error: 'Zona horaria inválida.' });
        return true;
      }
      const saved = await this.settings.update(input.revision, {
        ...current.value,
        ...parsed.data,
      });
      if (saved && this.apply) await this.apply((await this.settings.read()).value);
      send(
        saved ? 200 : 409,
        saved ? { saved: true, restartRequired: false } : { error: 'Recarga antes de guardar.' },
      );
    } else send(405, { error: 'Method not allowed' });
    return true;
  }
  /** First-run wizard state. Kept apart from the generic editor so it never blocks saves. */
  private async onboarding(
    req: IncomingMessage,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    const current = await this.settings.read();
    const setup = ServiceConfigSchema.shape.setup.parse(current.value.setup ?? {});
    const media = current.value.media;
    const status = () => ({
      revision: current.revision,
      ...setup,
      transcription:
        media.asrProvider === 'none'
          ? 'none'
          : media.speech?.stt && media.speech.stt !== 'default'
            ? 'home_assistant'
            : media.asrUrl || media.asrUrls?.length
              ? media.asrProvider === 'clipse-whisper'
                ? 'clipse-whisper'
                : 'legacy'
              : 'none',
      transcriptionSources: (media.asrUrl ? 1 : 0) + (media.asrUrls?.length ?? 0),
    });
    if (req.method === 'GET') {
      send(200, status());
      return;
    }
    if (req.method !== 'PUT') {
      send(405, { error: 'Method not allowed' });
      return;
    }
    const input = z
      .object({
        revision: z.number().int().positive(),
        mode: z.enum(['', 'telegram', 'home_assistant', 'both']).optional(),
        completed: z.boolean().optional(),
        transcription: z
          .object({
            provider: z.enum(['none', 'clipse-whisper']),
            urls: z
              .array(z.url({ protocol: /^https?$/ }).max(500))
              .max(16)
              .default([]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(await read());
    if (input.revision !== current.revision) {
      send(409, { error: 'La configuración ha cambiado. Recarga antes de guardar.' });
      return;
    }
    const value = structuredClone(current.value);
    value.setup = {
      mode: input.mode ?? setup.mode,
      completed: input.completed ?? setup.completed,
    };
    if (input.transcription) {
      const urls = [...new Set(input.transcription.urls.map((url) => url.trim()))];
      if (input.transcription.provider === 'clipse-whisper' && !urls.length) {
        send(400, { error: 'Añade al menos una URL de ClipSE Whisper.' });
        return;
      }
      value.media = {
        ...value.media,
        asrProvider: input.transcription.provider,
        // Keep a saved URL when transcription is turned off so it can be re-enabled.
        ...(urls.length ? { asrUrl: urls[0]!, asrUrls: urls.slice(1) } : {}),
      };
    }
    const saved = await this.settings.update(current.revision, {
      ...value,
      ...ServiceConfigSchema.parse(value),
    });
    if (!saved) {
      send(409, { error: 'Recarga antes de guardar.' });
      return;
    }
    if (this.apply) await this.apply((await this.settings.read()).value);
    send(200, { saved: true });
  }
}
