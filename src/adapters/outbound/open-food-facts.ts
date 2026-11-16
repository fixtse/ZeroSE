import type { FoodCatalog } from '../../application/food-catalog.js';

const fields = 'code,product_name,brands,nutriments,serving_size,url';
export class OpenFoodFacts implements FoodCatalog {
  constructor(private readonly request: typeof fetch = fetch) {}
  private async read(url: URL, signal?: AbortSignal) {
    const response = await this.request(url, {
      headers: { 'User-Agent': 'ZeroAssistant/1.0 (https://github.com/fixtse/zero-assistant)' },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Open Food Facts request failed: HTTP ${response.status}`);
    return response.json();
  }
  async search(query: string, page: number, limit: number, signal?: AbortSignal) {
    const url = new URL('https://world.openfoodfacts.org/cgi/search.pl');
    url.search = new URLSearchParams({
      search_terms: query,
      search_simple: '1',
      action: 'process',
      json: '1',
      fields,
      page: String(page),
      page_size: String(limit),
    }).toString();
    return this.read(url, signal);
  }
  async barcode(code: string, signal?: AbortSignal) {
    const url = new URL(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`,
    );
    url.searchParams.set('fields', fields);
    return this.read(url, signal);
  }
}
