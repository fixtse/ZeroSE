export type ImageSearchProviderId = 'brave' | 'searchapi' | 'serpapi';
export interface ImageSearchSettings {
  defaultProvider: ImageSearchProviderId;
  searchApiKey: string;
  serpApiKey: string;
}
export interface ImageSearchQuery {
  query: string;
  limit: number;
  size: 'any' | 'large';
  transparent: boolean;
}
export interface ImageSearchResult {
  title: string;
  url: string;
  source: string;
  width?: number;
  height?: number;
  provider: ImageSearchProviderId;
}
