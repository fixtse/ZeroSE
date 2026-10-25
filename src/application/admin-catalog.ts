import type { Config } from '../domain/config.js';

export interface AdminCatalogQuery {
  search: string;
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
