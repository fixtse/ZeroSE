import { z } from 'zod';
import type { AIProvider } from '../../domain/ai.js';
import { boundedBody } from './http.js';

const result = z.object({
  results: z
    .array(z.object({ index: z.number().int().min(0), relevance_score: z.number().finite() }))
    .max(20),
});
/** Cohere/Jina-compatible rerank endpoint. Connection secrets never reach model prompts. */
export async function httpRerank(
  provider: AIProvider,
  model: string,
  query: string,
  documents: string[],
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const base = new URL(provider.baseUrl.replace(/\/+$/, '') + '/rerank');
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Invalid reranking provider URL');
  const response = await request(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({ model, query, documents, top_n: documents.length }),
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Reranking provider returned HTTP ${response.status}`);
  const parsed = result.parse(
    JSON.parse((await boundedBody(response, 1024 * 1024)).toString('utf8')),
  );
  const indices = parsed.results
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .map((item) => item.index);
  if (
    new Set(indices).size !== indices.length ||
    indices.some((index) => index >= documents.length)
  )
    throw new Error('Invalid reranking indices');
  return indices;
}
