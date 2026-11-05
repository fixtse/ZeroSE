'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { contentTransition } from '../lib/motion';
import { MotionConfig } from 'framer-motion';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAdminQueryClient } from '../lib/query-client';

export function AdminQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createAdminQueryClient);
  useEffect(() => {
    // Removing queries also cancels pending reads, so old responses cannot refill
    // the cache after a mutation or a session boundary. Nothing is persisted.
    const clear = () => client.clear();
    window.addEventListener('zero-admin-changed', clear);
    window.addEventListener('zero-session-expired', clear);
    return () => {
      window.removeEventListener('zero-admin-changed', clear);
      window.removeEventListener('zero-session-expired', clear);
      client.clear();
    };
  }, [client]);
  return (
    <MotionConfig reducedMotion="user" transition={contentTransition}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MotionConfig>
  );
}
