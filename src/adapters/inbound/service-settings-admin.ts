import type { SchedulerSEPairing } from '../../application/schedulerse-pairing.js';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { ServiceConfig, ServiceSettingsPort } from '../../application/service-settings.js';
import type { SpeechQuery, SpeechPage, SpeechVoice } from '../../domain/speech.js';
import { secretHint } from '../../application/secret-hint.js';
import { ServiceConfigSchema } from '../outbound/config-schema.js';

const defaults = ServiceConfigSchema.parse({});
const template = {
  ...defaults,
  schedulerSE: { url: '', token: '', callbackUrl: '', enabled: false },
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
const dedicatedGroups = new Set(['memory', 'codex', 'telegram', 'google', 'homeAssistant']);
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
    private schedulerPairing?: SchedulerSEPairing,
  ) {}
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    if (path.startsWith('/v1/admin/setup/services/schedulerse/pairing')) {
      if (!this.schedulerPairing) {
        send(503, { error: 'Emparejamiento no disponible.' });
        return true;
      }
      try {
        const endpoint = '/v1/admin/setup/services/schedulerse/pairing';
        if (path === endpoint && req.method === 'GET') {
          const status = await this.schedulerPairing.status();
          if (status.state === 'configured' && this.apply)
            await this.apply((await this.settings.read()).value);
          send(200, status);
        } else if (path === endpoint && req.method === 'POST') {
          const input = z
            .object({ url: z.string().max(2048) })
            .strict()
            .parse(await read());
          send(201, await this.schedulerPairing.begin(input.url));
        } else if (path === endpoint + '/finish' && req.method === 'POST') {
          const result = await this.schedulerPairing.finish();
          if (this.apply) await this.apply((await this.settings.read()).value);
          send(200, result);
        } else send(405, { error: 'Método no permitido.' });
      } catch (error) {
        send(409, {
          error:
            error instanceof Error
              ? error.message
              : 'No se pudo confirmar la conexión. Consulta su estado.',
        });
      }
      return true;
    }
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
            field.type === 'secret' ? '' : (values[field.path] ?? flatten(template)[field.path]),
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
      if (
        value.schedulerSE &&
        !value.schedulerSE.enabled &&
        !value.schedulerSE.url &&
        !value.schedulerSE.token &&
        !value.schedulerSE.callbackUrl
      )
        delete value.schedulerSE;
      if (value.schedulerSE?.callbackUrl === '') delete value.schedulerSE.callbackUrl;
      const parsed = ServiceConfigSchema.safeParse(value);
      if (!parsed.success) {
        send(400, {
          error: 'Configuración inválida.',
          fields: parsed.error.issues.map((issue) => issue.path.join('.')),
        });
        return true;
      }
      try {
        new Intl.DateTimeFormat('en', { timeZone: parsed.data.timezone });
      } catch {
        send(400, { error: 'Zona horaria inválida.' });
        return true;
      }
      const saved = await this.settings.update(input.revision, parsed.data);
      if (saved && this.apply) await this.apply((await this.settings.read()).value);
      send(
        saved ? 200 : 409,
        saved ? { saved: true, restartRequired: false } : { error: 'Recarga antes de guardar.' },
      );
    } else send(405, { error: 'Method not allowed' });
    return true;
  }
}
