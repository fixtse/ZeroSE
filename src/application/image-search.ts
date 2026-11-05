import type { ImageSearchQuery, ImageSearchResult } from '../domain/image-search.js';
export interface ImageSearchPort {
  search(query: ImageSearchQuery, signal: AbortSignal): Promise<ImageSearchResult[]>;
}
