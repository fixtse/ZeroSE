import { providerEmbeddings, providerEmbeddingCatalog } from './provider-embeddings.js';
import type { Config } from '../../domain/config.js';
import type {
  EmbeddingSettings,
  AIProvider,
  AIModelCatalogQuery,
  AIModelCatalogPage,
} from '../../domain/ai.js';
import type { EmbeddingsPort } from '../../application/ports.js';
import { GeminiEmbeddings } from './gemini-embeddings.js';

export function memoryEmbeddings(
  config: Config['memory'],
  settings?: EmbeddingSettings,
  providers: AIProvider[] = [],
  request: typeof fetch = fetch,
): EmbeddingsPort {
  if (!settings || settings.mode === 'default') return new GeminiEmbeddings(config);
  if (settings.mode === 'disabled')
    return {
      enabled: false,
      embed: async () => {
        throw new Error('Embeddings disabled');
      },
    };
  if (settings.mode === 'provider') {
    const provider = providers.find((p) => p.id === settings.provider);
    if (!provider) throw new Error('The embedding connection is unavailable.');
    return providerEmbeddings(provider, settings, config.embeddingDimensions, request);
  }
  return new GeminiEmbeddings({
    ...config,
    geminiApiKey: settings.apiKey,
    embeddingModel: settings.model,
  });
}

export async function embeddingCatalog(
  settings: EmbeddingSettings,
  query: AIModelCatalogQuery,
  signal: AbortSignal,
  request: typeof fetch = fetch,
  provider?: AIProvider,
): Promise<AIModelCatalogPage> {
  if (settings.mode === 'provider') {
    if (!provider) throw new Error('The embedding connection is unavailable.');
    return providerEmbeddingCatalog(provider, query, signal, request);
  }
  const items: { id: string; name: string }[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '1000');
    if (token) url.searchParams.set('pageToken', token);
    const response = await request(url, {
      headers: { 'x-goog-api-key': settings.apiKey },
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Gemini model discovery returned HTTP ${response.status}`);
    const page = (await response.json()) as {
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      nextPageToken?: string;
    };
    if (!Array.isArray(page.models)) throw new Error('Invalid Gemini model catalog');
    items.push(
      ...page.models
        .filter((m) => m.supportedGenerationMethods?.includes('embedContent'))
        .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name })),
    );
    token = page.nextPageToken;
    if (token && seen.has(token)) throw new Error('Invalid Gemini catalog pagination');
    if (token) seen.add(token);
  } while (token && seen.size < 20);
  const filtered = items.filter((m) =>
    `${m.id} ${m.name}`.toLowerCase().includes(query.search.toLowerCase()),
  );
  return {
    items: filtered.slice(query.offset, query.offset + query.limit),
    total: filtered.length,
  };
}
