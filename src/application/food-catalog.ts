export interface FoodCatalog {
  search(query: string, page: number, limit: number, signal?: AbortSignal): Promise<unknown>;
  barcode(code: string, signal?: AbortSignal): Promise<unknown>;
}
