import { QueryClient } from '@tanstack/react-query';

export function createAdminQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false },
    },
  });
}

// Cache only discovery data. Session, credentials, pairing and editable settings
// must always be read from the server. The complete URL scopes pages and filters.
export function adminReadStaleTime(path: string): number | undefined {
  const pathname = path.split('?')[0];
  if (/^\/v1\/admin\/setup\/assistants(?:\/[^/]+)?$/.test(pathname)) return 30_000;
  if (
    /^\/v1\/admin\/profiles\/[^/]+\/[^/]+\/(?:entities|services|google\/(?:calendars|task-lists|document-folders))$/.test(
      pathname,
    )
  )
    return 30_000;
  // Rule status and next-fire times change independently of this UI.
  return undefined;
}
