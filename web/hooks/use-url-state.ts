'use client';
import { useCallback, useEffect, useState } from 'react';
export function useUrlState(key: string, fallback: string) {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    const sync = () => setValue(new URLSearchParams(location.search).get(key) || fallback);
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [key, fallback]);
  const update = useCallback(
    (next: string) => {
      const url = new URL(location.href);
      if (next === fallback) url.searchParams.delete(key);
      else url.searchParams.set(key, next);
      history.pushState(null, '', url);
      setValue(next);
    },
    [key, fallback],
  );
  return [value, update] as const;
}
