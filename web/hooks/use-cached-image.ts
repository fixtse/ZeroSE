'use client';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

// Avatars rarely change. Keep them across page changes; reload to force a refresh.
const imageCache = { staleTime: 6 * 3_600_000, gcTime: 24 * 3_600_000 } as const;

/** Telegram profile photo of a user or group, fetched through its assistant's bot. */
export function useProfilePhoto(bot: string, chatId: string) {
  const path = '/v1/admin/profiles/' + bot + '/' + encodeURIComponent(chatId) + '/photo';
  return useQuery({
    queryKey: ['admin', 'image', 'profile', bot, chatId],
    queryFn: async ({ signal }) =>
      (await api<{ image?: string }>(path, 'GET', undefined, signal)).image ?? null,
    enabled: !chatId.startsWith('ha:'),
    ...imageCache,
  }).data;
}

export const assistantImageKey = (id: string) => ['admin', 'image', 'assistant', id] as const;

/** Assistant picture saved in Zero. Editors announce changes with `assistant-image-changed`. */
export function useAssistantImage(id: string) {
  const client = useQueryClient();
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === id)
        void client.invalidateQueries({ queryKey: assistantImageKey(id) });
    };
    window.addEventListener('assistant-image-changed', changed);
    return () => window.removeEventListener('assistant-image-changed', changed);
  }, [client, id]);
  return useQuery({
    queryKey: assistantImageKey(id),
    queryFn: async ({ signal }) =>
      (
        await api<{ image: string | null }>(
          '/v1/admin/setup/assistants/' + encodeURIComponent(id) + '/image',
          'GET',
          undefined,
          signal,
        )
      ).image,
    ...imageCache,
  }).data;
}
