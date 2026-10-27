import { secretHint } from '../../application/secret-hint.js';
import { z } from 'zod';
import { embeddingProviderKinds, type AIProvider } from '../../domain/ai.js';
import type {
  EmbeddingSettings,
  AIModelCatalogQuery,
  AIModelCatalogPage,
} from '../../domain/ai.js';

export const embeddingSettingsSchema = z
  .object({
    mode: z.enum(['default', 'disabled', 'gemini', 'provider']),
    provider: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    dimensions: z.number().int().min(1).max(4000).optional(),
    model: z.string().trim().max(200).default(''),
    baseUrl: z.string().max(1000).default(''),
    apiKey: z.string().max(4000).default(''),
    clearApiKey: z.boolean().optional(),
  })
  .strict();

export class EmbeddingAdmin {
  constructor(
    private defaults: { model: string; apiKey: string; dimensions: number },
    private discover: (
      settings: EmbeddingSettings,
      query: AIModelCatalogQuery,
      signal: AbortSignal,
      provider?: AIProvider,
    ) => Promise<AIModelCatalogPage>,
    private testModel?: (
      settings: EmbeddingSettings,
      provider?: AIProvider,
    ) => Promise<{ dimensions: number }>,
  ) {}
  read(value?: EmbeddingSettings) {
    const current = value || {
      mode: 'default',
      model: this.defaults.model,
      baseUrl: '',
      apiKey: '',
    };
    return {
      ...current,
      ...(current.mode === 'default'
        ? {
            mode: 'gemini' as const,
            model: this.defaults.model,
            dimensions: this.defaults.dimensions,
          }
        : {}),
      apiKey: '',
      hasApiKey: !!(current.mode === 'default' ? this.defaults.apiKey : current.apiKey),
      secretHint: secretHint(current.mode === 'default' ? this.defaults.apiKey : current.apiKey),
    };
  }
  get info() {
    return {
      dimensions: this.defaults.dimensions,
      reranker: false,
      server: {
        provider: 'gemini',
        model: this.defaults.model,
        dimensions: this.defaults.dimensions,
        hasApiKey: !!this.defaults.apiKey,
      },
    };
  }
  merge(
    input: z.infer<typeof embeddingSettingsSchema>,
    previous?: EmbeddingSettings,
    providers: AIProvider[] = [],
  ): EmbeddingSettings {
    const { clearApiKey, ...value } = input;
    if (value.dimensions && value.dimensions > this.defaults.dimensions)
      throw new Error('Las dimensiones superan la capacidad de la base de datos.');
    if (value.mode === 'provider') {
      const connection = providers.find((p) => p.id === value.provider);
      if (!connection || !embeddingProviderKinds.includes(connection.kind))
        throw new Error('Selecciona una conexión disponible para embeddings.');
      if (!value.model) throw new Error('Selecciona un modelo de embeddings.');
      if (connection.kind === 'compatible' && !connection.baseUrl)
        throw new Error('La conexión necesita una URL base.');
      if (['openai', 'openrouter'].includes(connection.kind) && !connection.apiKey)
        throw new Error('La conexión necesita una API key.');
      return { ...value, apiKey: '', baseUrl: '' };
    }
    if (value.baseUrl) {
      const url = new URL(value.baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('URL de embeddings no válida.');
    }
    const apiKey = clearApiKey
      ? ''
      : value.apiKey ||
        (previous?.mode === value.mode && previous.baseUrl === value.baseUrl
          ? previous.apiKey
          : value.mode === 'gemini' && (!previous || previous.mode === 'default') && !value.baseUrl
            ? this.defaults.apiKey
            : '');
    if (value.mode === 'gemini' && !value.model)
      throw new Error('Selecciona un modelo de embeddings.');
    if (value.mode === 'gemini' && !apiKey)
      throw new Error('Gemini necesita una API key para embeddings.');
    if (value.mode === 'gemini' && value.baseUrl) throw new Error('Gemini usa su URL oficial.');
    return { ...value, apiKey: ['default', 'disabled'].includes(value.mode) ? '' : apiKey };
  }
  async catalog(
    input: z.infer<typeof embeddingSettingsSchema>,
    previous: EmbeddingSettings | undefined,
    query: AIModelCatalogQuery,
    providers: AIProvider[] = [],
  ) {
    // Model selection is what discovery provides, so it need not be present yet.
    const value = this.merge({ ...input, model: input.model || 'discovery' }, previous, providers);
    const settings: EmbeddingSettings =
      value.mode === 'default'
        ? { mode: 'gemini', model: this.defaults.model, baseUrl: '', apiKey: this.defaults.apiKey }
        : value;
    if (settings.mode === 'disabled') return { items: [], total: 0 };
    return this.discover(
      settings,
      query,
      AbortSignal.timeout(15000),
      providers.find((p) => p.id === settings.provider),
    );
  }
  async test(
    input: z.infer<typeof embeddingSettingsSchema>,
    previous: EmbeddingSettings | undefined,
    providers: AIProvider[],
  ) {
    if (!this.testModel) throw new Error('Prueba de embeddings no disponible.');
    const value = this.merge(input, previous, providers);
    if (value.mode === 'disabled') throw new Error('Los embeddings están desactivados.');
    return this.testModel(
      value,
      providers.find((p) => p.id === value.provider),
    );
  }
}
