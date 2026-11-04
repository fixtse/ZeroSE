import type { Config } from '../domain/config.js';

export interface AdminCatalogQuery {
  search: string;
  domains?: string;
  purpose?: 'location-assignment';
  offset: number;
  limit: number;
}
export interface AdminCatalogPort {
  entities(
    query: AdminCatalogQuery,
    signal: AbortSignal,
  ): Promise<{
    items: { id: string; name: string; access: string[] }[];
    total: number;
  }>;
  services(
    query: AdminCatalogQuery,
    signal: AbortSignal,
  ): Promise<{
    items: { id: string; name: string }[];
    total: number;
  }>;
}
export type AdminCatalogFactory = (config: Config) => AdminCatalogPort;

export type GoogleDestinationKind = 'calendars' | 'task-lists' | 'document-folders';
export interface GoogleDestinationQuery {
  search: string;
  limit: number;
  pageToken: string;
}
export type GoogleDestinationFactory = (config: Config) => {
  destinations(
    kind: GoogleDestinationKind,
    query: GoogleDestinationQuery,
    signal: AbortSignal,
  ): Promise<{
    items: { id: string; name: string }[];
    nextPageToken?: string;
  }>;
};
