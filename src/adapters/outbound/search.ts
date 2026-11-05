import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Tools, text } from '../../application/tool-registry.js';
import { jsonPage } from '../../application/context-budget.js';
import { boundedBody, RemoteError } from './http.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Retain bounded, turn-scoped snapshots so fragment reads do not repeat paid searches.
const webPages = new Map<string, { expires: number; value: unknown }>();
const webSearchQuery = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(600)
    .refine((value) => value.split(/\s+/).length <= 75, 'Use at most 75 query words'),
  page: z.number().int().min(0).max(9).default(0),
  limit: z.number().int().min(1).max(20).default(5),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[a-z]{2,4})?$/)
    .optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  freshness: z.enum(['pd', 'pw', 'pm', 'py']).optional(),
  result_offset: z.number().int().min(0).max(1_000_000).default(0),
});
const webResponse = z.object({
  query: z.object({ more_results_available: z.boolean().optional() }).optional(),
  web: z
    .object({
      results: z.array(
        z.object({
          title: z.string(),
          url: z.url(),
          description: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

// URL reads must never give model-supplied URLs access to private integration endpoints.
function publicAddress(address: string) {
  if (isIP(address) === 6)
    return !/^(::|fc|fd|fe[89ab]|ff)/i.test(address) && !address.toLowerCase().includes('ffff:');
  const [a, b] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
export function registerSearch(
  tools: Tools,
  key: string,
  reader = { url: 'https://r.jina.ai/', apiKey: '' },
) {
  if (key) {
    let imageQueue: Promise<unknown> = Promise.resolve();
    let nextImageRequest = 0;
    const imagePages = new Map<string, { expires: number; value: unknown }>();
    tools.add(
      'web_search',
      'Search public web pages with Brave. Returns titles, URLs and excerpts; use url_read for full pages. Continue with next_page, or result_offset for fragments of the same page.',
      webSearchQuery,
      async (a, c) => {
        const { result_offset, ...query } = a;
        const cacheKey = createHash('sha256')
          .update(JSON.stringify([key, c.session, c.jobId, query]))
          .digest('hex');
        const now = Date.now();
        for (const [id, cached] of webPages) if (cached.expires <= now) webPages.delete(id);
        if (result_offset) {
          const cached = webPages.get(cacheKey);
          if (!cached)
            throw new Error(
              'Search page expired. Start the same search again with result_offset=0.',
            );
          return jsonPage(cached.value, result_offset);
        }
        const params = new URLSearchParams({
          q: query.query,
          count: String(query.limit),
          offset: String(query.page),
          result_filter: 'web',
          safesearch: 'moderate',
          ...(query.language ? { search_lang: query.language } : {}),
          ...(query.country ? { country: query.country } : {}),
          ...(query.freshness ? { freshness: query.freshness } : {}),
        });
        const response = await fetch('https://api.search.brave.com/res/v1/web/search?' + params, {
          headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.any([c.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new RemoteError('Brave Web Search', response.status);
        const result = webResponse.parse(
          JSON.parse((await boundedBody(response, 1_000_000)).toString('utf8')),
        );
        const items = (result.web?.results || []).slice(0, query.limit).map((item) => ({
          title: item.title,
          url: item.url,
          description: item.description || '',
        }));
        const value = {
          items,
          page: query.page,
          next_page:
            items.length && result.query?.more_results_available && query.page < 9
              ? query.page + 1
              : null,
        };
        webPages.delete(cacheKey);
        if (webPages.size >= 16) webPages.delete(webPages.keys().next().value!);
        webPages.set(cacheKey, { expires: Date.now() + 300_000, value });
        return jsonPage(value);
      },
    );
    tools.add(
      'image_search',
      'Find candidate image URLs with Brave; results do not verify transparency or exact model. Search each requested item once before refining. For large document tasks, save a first pass with document_create before optional refinements; mark unresolved matches. Fragments use the same query and result_offset=next_offset without another search.',
      z.object({ query: text, result_offset: z.number().int().min(0).default(0) }),
      async (a, c) => {
        const cacheKey = createHash('sha256')
          .update(JSON.stringify([c.session, c.jobId, a.query]))
          .digest('hex');
        for (const [id, cached] of imagePages)
          if (cached.expires <= Date.now()) imagePages.delete(id);
        const read = () => {
          const cached = imagePages.get(cacheKey);
          if (!cached) throw new Error('Image search page expired. Restart with result_offset=0.');
          return jsonPage(cached.value, a.result_offset);
        };
        if (a.result_offset || imagePages.has(cacheKey)) return read();
        const pending = imageQueue.then(async () => {
          c.signal.throwIfAborted();
          if (imagePages.has(cacheKey)) return read();
          // Space request starts even when callers issue a batch concurrently.
          const wait = nextImageRequest - Date.now();
          if (wait > 0) await delay(wait, undefined, { signal: c.signal });
          c.signal.throwIfAborted();
          nextImageRequest = Date.now() + 1100;
          const response = await fetch(
            'https://api.search.brave.com/res/v1/images/search?' +
              new URLSearchParams({ q: a.query, count: '5' }),
            {
              headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
              redirect: 'error',
              signal: AbortSignal.any([c.signal, AbortSignal.timeout(15_000)]),
            },
          );
          if (!response.ok) throw new RemoteError('Brave Image Search', response.status);
          const result = JSON.parse((await boundedBody(response, 1_000_000)).toString('utf8'));
          const value = (result.results || []).slice(0, 5).map((r: any) => ({
            title: r.title,
            url: r.properties?.url,
            source: r.url,
          }));
          if (imagePages.size >= 128) imagePages.delete(imagePages.keys().next().value!);
          imagePages.set(cacheKey, { expires: Date.now() + 900_000, value });
          return read();
        });
        imageQueue = pending.catch(() => {});
        return pending;
      },
    );
  }
  tools.add(
    'url_read',
    'Read text from a public HTTPS web page when the user supplies a URL or search results need more detail. Preserve source links in the reply. Cannot access private network services. Large results return JSON fragments; continue with result_offset=next_offset and the same URL.',
    z.object({ url: z.url(), result_offset: z.number().int().min(0).default(0) }),
    async (a, c) => {
      const url = new URL(a.url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (url.port && url.port !== '443')
      )
        throw new Error('Only public HTTPS pages are supported');
      const addresses = await lookup(url.hostname, { all: true });
      if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
        throw new Error('Private network URLs are not permitted');
      // Jina fetches the public page remotely, so DNS rebinding cannot reach this host's LAN.
      const response = await fetch(reader.url.replace(/\/?$/, '/') + url.href, {
        headers: reader.apiKey ? { Authorization: 'Bearer ' + reader.apiKey } : {},
        redirect: 'error',
        signal: c.signal,
      });
      return jsonPage(
        {
          url: url.href,
          text: (await boundedBody(response, 500_000)).toString('utf8'),
        },
        a.result_offset,
      );
    },
  );
}
