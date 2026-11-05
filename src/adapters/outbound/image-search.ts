import { z } from 'zod';
import type { ImageSearchPort } from '../../application/image-search.js';
import type {
  ImageSearchProviderId,
  ImageSearchQuery,
  ImageSearchResult,
  ImageSearchSettings,
} from '../../domain/image-search.js';
import { boundedBody, RemoteError } from './http.js';

const dimension = z.number().int().positive().optional().catch(undefined);
const webUrl = z.string().url().refine((value) => /^https?:\/\//.test(value));
const image = z.object({
  title: z.string().default(''),
  url: webUrl,
  source: webUrl,
  width: dimension,
  height: dimension,
});
export interface ImageSearchProvider extends ImageSearchPort {
  id: ImageSearchProviderId;
  name: string;
  supportsFilters: boolean;
}

/** Fixed public endpoints only; provider payloads and credentials never cross the port. */
class Images implements ImageSearchProvider {
  constructor(
    readonly id: ImageSearchProviderId,
    readonly name: string,
    readonly supportsFilters: boolean,
    private key: string,
  ) {}
  async search(query: ImageSearchQuery, signal: AbortSignal): Promise<ImageSearchResult[]> {
    const params = new URLSearchParams({ q: query.query });
    let endpoint: string;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.id === 'brave') {
      endpoint = 'https://api.search.brave.com/res/v1/images/search';
      params.set('count', String(query.limit));
      // Brave has no native size/transparency filter. Search hints are not verification.
      if (query.transparent || query.size === 'large')
        params.set('q', [query.transparent ? 'transparent png' : '', query.size === 'large' ? 'high resolution' : '', query.query].filter(Boolean).join(' ').split(/\s+/).slice(0, 50).join(' ').slice(0, 400));
      headers['X-Subscription-Token'] = this.key;
    } else if (this.id === 'searchapi') {
      endpoint = 'https://www.searchapi.io/api/v1/search';
      params.set('engine', 'google_images');
      headers.Authorization = 'Bearer ' + this.key;
      if (query.transparent) params.set('color', 'transparent');
      if (query.size === 'large') params.set('size', 'large');
    } else {
      endpoint = 'https://serpapi.com/search.json';
      params.set('engine', 'google_images');
      params.set('api_key', this.key);
      if (query.transparent) params.set('image_color', 'trans');
      if (query.size === 'large') params.set('imgsz', 'l');
    }
    const response = await fetch(endpoint + '?' + params, {
      headers,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) throw new RemoteError(this.name, response.status);
    let data: any;
    try {
      data = JSON.parse((await boundedBody(response, 4_000_000)).toString('utf8'));
    } catch {
      throw new Error(`${this.name} returned invalid JSON or exceeded the response size limit`);
    }
    if (!data || typeof data !== 'object' || data.error)
      throw new Error(`${this.name} search failed; check provider settings and quota`);
    const raw = this.id === 'brave' ? data.results : this.id === 'searchapi' ? data.images : data.images_results;
    if (raw !== undefined && !Array.isArray(raw))
      throw new Error(`${this.name} returned invalid image results`);
    const results: ImageSearchResult[] = [];
    for (const item of raw || []) {
      if (!item || typeof item !== 'object') continue;
      const candidate = this.id === 'brave'
        ? { title: item.title ?? '', url: item.properties?.url, source: item.url, width: item.properties?.width, height: item.properties?.height }
        : this.id === 'searchapi'
          ? { title: item.title ?? '', url: item.original?.link, source: item.source?.link, width: item.original?.width, height: item.original?.height }
          : { title: item.title ?? '', url: item.original, source: item.link, width: item.original_width, height: item.original_height };
      const parsed = image.safeParse(candidate);
      if (parsed.success) results.push({ ...parsed.data, provider: this.id });
      if (results.length >= query.limit) break;
    }
    return results;
  }
}
export function imageSearchProviders(braveKey: string, settings?: ImageSearchSettings): ImageSearchProvider[] {
  return [
    ...(braveKey ? [new Images('brave', 'Brave Image Search', false, braveKey)] : []),
    ...(settings?.searchApiKey ? [new Images('searchapi', 'SearchAPI Google Images', true, settings.searchApiKey)] : []),
    ...(settings?.serpApiKey ? [new Images('serpapi', 'SerpApi Google Images', true, settings.serpApiKey)] : []),
  ];
}
