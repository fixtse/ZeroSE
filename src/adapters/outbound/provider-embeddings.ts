import { createHash } from 'node:crypto';
import {
  embeddingProviderKinds,
  type AIProvider,
  type EmbeddingSettings,
  type AIModelCatalogQuery,
} from '../../domain/ai.js';
import type { EmbeddingsPort } from '../../application/ports.js';
import { boundedBody } from './http.js';

const endpoints: Partial<Record<AIProvider['kind'], string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
};
export function embeddingBase(provider: AIProvider) {
  if (!embeddingProviderKinds.includes(provider.kind))
    throw new Error('This connection does not support embeddings.');
  const base = (provider.baseUrl || endpoints[provider.kind] || '').replace(/\/+$/, '');
  if (!base) throw new Error('Configure the embedding provider URL.');
  const url = new URL(base);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid embedding provider URL.');
  return base;
}
const headers = (provider: AIProvider) => ({
  'Content-Type': 'application/json',
  ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
});
async function json(response: Response) {
  if (!response.ok)
    throw new Error(
      `Embedding provider returned HTTP ${response.status}. Check the connection, model and permissions.`,
    );
  const body = (await boundedBody(response, 8 * 1024 * 1024)).toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Invalid embedding provider response.');
  }
}

export function providerEmbeddings(
  provider: AIProvider,
  settings: EmbeddingSettings,
  storageDimensions: number,
  request: typeof fetch = fetch,
): EmbeddingsPort {
  const base = embeddingBase(provider);
  const identity = JSON.stringify([
    provider.id,
    provider.kind,
    base,
    settings.model,
    settings.dimensions || 'native',
    storageDimensions,
  ]);
  return {
    enabled: true,
    space: 'provider:' + createHash('sha256').update(identity).digest('hex'),
    async embed(text, taskType, signal) {
      const body = {
        model: settings.model,
        input: text,
        encoding_format: 'float',
        ...(settings.dimensions ? { dimensions: settings.dimensions } : {}),
        ...(provider.kind === 'openrouter'
          ? { input_type: taskType === 'RETRIEVAL_QUERY' ? 'search_query' : 'search_document' }
          : {}),
      };
      const result = await json(
        await request(base + '/embeddings', {
          method: 'POST',
          headers: headers(provider),
          body: JSON.stringify(body),
          redirect: 'error',
          signal: signal || AbortSignal.timeout(30000),
        }),
      );
      const vector = result.data?.length === 1 ? result.data[0]?.embedding : undefined;
      if (
        !Array.isArray(vector) ||
        !vector.length ||
        !vector.every(Number.isFinite) ||
        vector.length > storageDimensions ||
        (settings.dimensions && vector.length !== settings.dimensions)
      )
        throw new Error(
          'Invalid embedding vector or incompatible dimensions. Select an output size that fits the memory database.',
        );
      // Padding smaller native vectors preserves cosine similarity and the existing pgvector schema.
      return [...vector, ...Array<number>(storageDimensions - vector.length).fill(0)];
    },
  };
}

export async function providerEmbeddingCatalog(
  provider: AIProvider,
  query: AIModelCatalogQuery,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const base = embeddingBase(provider);
  const data = await json(
    await request(base + (provider.kind === 'openrouter' ? '/embeddings/models' : '/models'), {
      headers: headers(provider),
      signal,
      redirect: 'error',
    }),
  );
  if (!Array.isArray(data.data)) throw new Error('Invalid embedding model catalog.');
  let models = data.data.filter((m: any) => typeof m?.id === 'string' && m.id.length <= 200);
  if (provider.kind === 'openai') models = models.filter((m: any) => /^text-embedding-/.test(m.id));
  // Compatible APIs do not consistently advertise capabilities; exclude explicit non-embedding models.
  if (provider.kind === 'compatible')
    models = models.filter(
      (m: any) =>
        !Array.isArray(m.capabilities) ||
        m.capabilities.some((c: unknown) => c === 'embedding' || c === 'embeddings'),
    );
  const search = query.search.toLowerCase();
  models = models.filter((m: any) => `${m.id} ${m.name || ''}`.toLowerCase().includes(search));
  models = [...new Map<string, any>(models.map((m: any) => [m.id, m])).values()].sort(
    (a: any, b: any) => a.id.localeCompare(b.id),
  );
  const page = models.slice(query.offset, query.offset + query.limit);
  const items: { id: string; name: string }[] = [];
  for (const model of page) {
    if (provider.kind === 'ollama') {
      const root = base.replace(/\/v1$/, '');
      const info = await json(
        await request(root + '/api/show', {
          method: 'POST',
          headers: headers(provider),
          body: JSON.stringify({ model: model.id }),
          signal,
          redirect: 'error',
        }),
      );
      if (!info.capabilities?.includes('embedding')) continue;
    }
    items.push({ id: model.id, name: typeof model.name === 'string' ? model.name : model.id });
  }
  return { items, total: models.length };
}
