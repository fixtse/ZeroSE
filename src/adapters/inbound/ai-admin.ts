import { secretHint } from '../../application/secret-hint.js';
import type { ReprocessMemory } from '../../application/reprocess-memory.js';
import { EmbeddingAdmin, embeddingSettingsSchema } from './embedding-admin.js';
import type { AdminCatalogQuery } from '../../application/admin-catalog.js';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import {
  aiEfforts,
  aiProviderKinds,
  type AIModelCatalog,
  type AISettingsPort,
} from '../../domain/ai.js';
const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
  .refine((v) => v !== 'default');
export const modelPermissionsSchema = {
  defaultModel: id.or(z.literal('')).optional(),
  alternateModels: z.array(id).max(30).optional(),
};
const schema = z
  .object({
    revision: z.number().int().positive(),
    defaultModel: id,
    embeddings: embeddingSettingsSchema.optional(),
    reranking: z
      .object({
        enabled: z.boolean(),
        provider: id.or(z.literal('')),
        model: z.string().trim().max(200),
        api: z.enum(['model', 'rerank']).optional(),
        effort: z.enum(aiEfforts).optional(),
      })
      .strict()
      .optional(),
    providers: z
      .array(
        z
          .object({
            id,
            scope: z.enum(['conversation', 'embeddings', 'reranking']).optional(),
            name: z.string().trim().max(100).default(''),
            kind: z.enum(aiProviderKinds),
            baseUrl: z.string().max(1000).default(''),
            apiKey: z.string().max(4000).default(''),
            clearApiKey: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    models: z
      .array(
        z
          .object({
            id,
            label: z.string().trim().min(1).max(100),
            provider: id,
            model: z.string().trim().min(1).max(200),
            effort: z.enum(aiEfforts).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export class AIAdmin {
  constructor(
    private settings: AISettingsPort,
    private homeAssistantCatalog?: (
      query: AdminCatalogQuery,
      signal: AbortSignal,
    ) => Promise<{ items: { id: string; name: string }[]; total: number }>,
    private modelCatalog?: AIModelCatalog,
    private embeddingAdmin?: EmbeddingAdmin,
    private reprocessMemory?: ReprocessMemory,
    private rerankingTest?: () => Promise<void>,
    private codexAvailable: () => Promise<boolean> = async () => false,
  ) {}
  async validateModels(defaultModel?: string, alternateModels?: string[]) {
    const settings = await this.settings.read();
    const ids = new Set(settings.models.map((m) => m.id));
    if ([defaultModel, ...(alternateModels || [])].some((id) => id && !ids.has(id)))
      throw new Error('Selecciona modelos disponibles en Proveedores IA.');
  }
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    if (path === '/v1/admin/ai/reranking/test' && req.method === 'POST') {
      const input = z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(await read());
      const value = await this.settings.read();
      if (input.revision !== value.revision)
        throw new Error('La configuración cambió. Recarga antes de probar.');
      if (!value.reranking?.enabled || !this.rerankingTest)
        throw new Error('Activa y guarda el reranking antes de probar.');
      await this.rerankingTest();
      send(200, { compatible: true });
      return true;
    }
    if (path === '/v1/admin/ai/api-key' && req.method === 'DELETE') {
      const input = z
        .object({ revision: z.number().int(), provider: id.optional() })
        .strict()
        .parse(await read());
      const previous = await this.settings.read();
      if (input.revision !== previous.revision) {
        send(409, { error: 'La configuración ha cambiado. Recarga antes de borrar la clave.' });
        return true;
      }
      if (input.provider && !previous.providers.some((p) => p.id === input.provider))
        throw new Error('Conexión no disponible.');
      const embeddings = previous.embeddings;
      const saved = await this.settings.update({
        ...previous,
        ...(input.provider
          ? {
              providers: previous.providers.map((p) =>
                p.id === input.provider ? { ...p, apiKey: '' } : p,
              ),
            }
          : {
              embeddings: {
                ...embeddings,
                mode: 'disabled',
                model: embeddings?.model || '',
                baseUrl: '',
                apiKey: '',
              },
            }),
      });
      send(
        saved ? 200 : 409,
        saved
          ? { saved: true }
          : { error: 'La configuración ha cambiado. Recarga antes de borrar la clave.' },
      );
      return true;
    }
    if (path === '/v1/admin/ai/embeddings/reprocess' && req.method === 'POST') {
      const input = z
        .object({ revision: z.number().int(), after: z.string().regex(/^(0|[1-9]\d{0,18})$/) })
        .strict()
        .parse(await read());
      const saved = await this.settings.read();
      if (saved.revision !== input.revision)
        throw new Error('La configuración cambió. Recarga antes de reprocesar.');
      if (!this.reprocessMemory) throw new Error('Reprocesado no disponible.');
      send(200, await this.reprocessMemory.batch(input.after));
      return true;
    }
    if (
      ['/v1/admin/ai/embeddings/models', '/v1/admin/ai/embeddings/test'].includes(path) &&
      req.method === 'POST'
    ) {
      if (!this.embeddingAdmin) {
        send(503, { error: 'Catálogo de embeddings no disponible.' });
        return true;
      }
      const input = z
        .object({
          embeddings: embeddingSettingsSchema,
          connection: schema.shape.providers.element.optional(),
          search: z.string().max(200).default(''),
          offset: z.number().int().min(0).max(1000000).default(0),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict()
        .parse(await read());
      const saved = await this.settings.read();
      const providers = [...saved.providers];
      if (input.connection) {
        const { clearApiKey, ...draft } = input.connection;
        if (draft.id !== input.embeddings.provider)
          throw new Error('La conexión no coincide con la selección de embeddings.');
        const old = saved.providers.find((p) => p.id === draft.id);
        const connection = {
          ...draft,
          apiKey: clearApiKey
            ? ''
            : draft.apiKey ||
              (old?.kind === draft.kind && old.baseUrl === draft.baseUrl ? old.apiKey : ''),
        };
        // Validate the URL before either discovery or a test sends credentials.
        if (connection.baseUrl) {
          const url = new URL(connection.baseUrl);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new Error('URL de proveedor no válida.');
        }
        const index = providers.findIndex((p) => p.id === connection.id);
        if (index < 0) providers.push(connection);
        else providers[index] = connection;
      }
      send(
        200,
        path.endsWith('/test')
          ? await this.embeddingAdmin.test(input.embeddings, saved.embeddings, providers)
          : await this.embeddingAdmin.catalog(
              input.embeddings,
              saved.embeddings,
              { search: input.search, offset: input.offset, limit: input.limit },
              providers,
            ),
      );
      return true;
    }
    if (path === '/v1/admin/ai/models' && req.method === 'POST') {
      if (!this.modelCatalog) {
        send(503, { error: 'Catálogo de modelos no disponible.' });
        return true;
      }
      const input = z
        .object({
          provider: schema.shape.providers.element,
          search: z.string().max(200).default(''),
          offset: z.number().int().min(0).max(1000000).default(0),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict()
        .parse(await read());
      const { clearApiKey, ...draft } = input.provider;
      const previous = (await this.settings.read()).providers.find((p) => p.id === draft.id);
      const provider = {
        ...draft,
        apiKey: clearApiKey
          ? ''
          : draft.apiKey ||
            (previous?.kind === draft.kind && previous.baseUrl === draft.baseUrl
              ? previous.apiKey
              : ''),
      };
      if (provider.baseUrl) {
        const url = new URL(provider.baseUrl);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error('URL de proveedor no válida.');
      }
      const query = { search: input.search, offset: input.offset, limit: input.limit };
      send(200, await this.modelCatalog(provider, query, AbortSignal.timeout(15000)));
      return true;
    }
    if (path === '/v1/admin/ai/home-assistant/models' && req.method === 'GET') {
      if (!this.homeAssistantCatalog) {
        send(503, { error: 'Catálogo IA de Home Assistant no disponible.' });
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
      send(200, {
        ...(await this.homeAssistantCatalog(query, AbortSignal.timeout(15000))),
        ...query,
      });
      return true;
    }
    if (path !== '/v1/admin/ai') return false;
    if (req.method === 'GET') {
      const value = await this.settings.read();
      send(200, {
        ...value,
        codexAvailable: await this.codexAvailable(),
        embeddings: this.embeddingAdmin
          ? this.embeddingAdmin.read(value.embeddings)
          : value.embeddings
            ? {
                ...value.embeddings,
                apiKey: '',
                hasApiKey: !!value.embeddings.apiKey,
                secretHint: secretHint(value.embeddings.apiKey),
              }
            : undefined,
        embeddingInfo: this.embeddingAdmin
          ? { ...this.embeddingAdmin.info, reranker: !!value.reranking?.enabled }
          : undefined,
        providers: value.providers.map(({ apiKey, ...p }) => ({
          ...p,
          apiKey: '',
          hasApiKey: !!apiKey,
          secretHint: secretHint(apiKey),
        })),
      });
    } else if (req.method === 'PUT') {
      const input = schema.parse(await read());
      const previous = await this.settings.read();
      if (input.revision !== previous.revision) {
        send(409, { error: 'La configuración ha cambiado. Recarga antes de guardar.' });
        return true;
      }
      if (
        new Set(input.providers.map((p) => p.id)).size !== input.providers.length ||
        new Set(input.models.map((m) => m.id)).size !== input.models.length
      )
        throw new Error('Los identificadores deben ser únicos.');
      const providers = input.providers.map(({ clearApiKey, ...p }) => {
        const old = previous.providers.find((v) => v.id === p.id);
        const apiKey = clearApiKey
          ? ''
          : p.apiKey || (old?.kind === p.kind && old.baseUrl === p.baseUrl ? old.apiKey : '');
        if (p.baseUrl) {
          const url = new URL(p.baseUrl);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new Error(
              'URL de proveedor no válida. Usa una URL HTTP(S) sin credenciales ni parámetros.',
            );
        }
        if (p.kind === 'compatible' && !p.baseUrl)
          throw new Error('OpenAI compatible necesita una URL base.');
        if (!['codex', 'ollama', 'compatible', 'home_assistant'].includes(p.kind) && !apiKey)
          throw new Error('Este proveedor necesita una API key.');
        if (p.kind === 'home_assistant' && (p.baseUrl || apiKey))
          throw new Error(
            'Home Assistant reutiliza la conexión del perfil; no necesita otra URL ni API key.',
          );
        return { ...p, apiKey };
      });
      if (
        !input.models.some((m) => m.id === input.defaultModel) ||
        input.models.some(
          (m) =>
            !providers.some((p) => p.id === m.provider && (!p.scope || p.scope === 'conversation')),
        )
      )
        throw new Error('El modelo predeterminado y los proveedores deben existir.');
      if (
        input.models.some(
          (m) =>
            providers.find((p) => p.id === m.provider)?.kind === 'home_assistant' &&
            m.model !== 'preferred' &&
            !/^ai_task\.[a-z0-9_]+$/.test(m.model),
        )
      )
        throw new Error('Selecciona una entidad ai_task de Home Assistant o preferred.');
      if (input.embeddings && !this.embeddingAdmin)
        throw new Error('Configuración de embeddings no disponible.');
      if (
        input.models.some(
          (m) =>
            m.effort &&
            !['codex', 'openai', 'openrouter', 'compatible', 'ollama'].includes(
              providers.find((p) => p.id === m.provider)!.kind,
            ),
        )
      )
        throw new Error('Este proveedor no permite configurar el esfuerzo desde Zero.');
      const reranking = input.reranking || previous.reranking;
      if (reranking?.enabled) {
        const connection = providers.find((item) => item.id === reranking.provider);
        if (!connection || connection.kind === 'home_assistant' || !reranking.model)
          throw new Error('Selecciona una conexión y un modelo disponibles para reranking.');
        if (reranking.api === 'rerank' && (connection.kind === 'codex' || !connection.baseUrl))
          throw new Error('La API de reranking necesita una conexión HTTP con URL base.');
      }
      const embeddings = input.embeddings
        ? this.embeddingAdmin!.merge(input.embeddings, previous.embeddings, providers)
        : previous.embeddings;
      if (embeddings?.mode === 'provider')
        this.embeddingAdmin!.merge(embeddings, previous.embeddings, providers);
      const saved = await this.settings.update({
        ...input,
        providers,
        ...(embeddings ? { embeddings } : {}),
        ...(reranking ? { reranking } : {}),
      });
      send(
        saved ? 200 : 409,
        saved
          ? { saved: true }
          : { error: 'La configuración ha cambiado. Recarga antes de guardar.' },
      );
    } else send(405, { error: 'Método no permitido.' });
    return true;
  }
}
