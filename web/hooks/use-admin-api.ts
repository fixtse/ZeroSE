'use client';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { adminReadStaleTime } from '../lib/query-client';

export function useAdminApi() {
  const client = useQueryClient();
  return function read<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const staleTime = method === 'GET' ? adminReadStaleTime(path) : undefined;
    if (staleTime === undefined) return api<T>(path, method, body);
    return client.fetchQuery({
      queryKey: ['admin', path],
      queryFn: ({ signal }) => api<T>(path, method, body, signal),
      staleTime,
    });
  };
}
