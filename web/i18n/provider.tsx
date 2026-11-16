'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  defaultLocale,
  isLocale,
  localeStorageKey,
  resolvePreferredLocale,
  type Locale,
} from './config';
import { createTranslator } from './translate';

const I18nContext = createContext<{
  locale: Locale;
  setLocale(locale: Locale): void;
  translate: ReturnType<typeof createTranslator>;
} | null>(null);

function preferredLocale(): Locale {
  const queryLocale = new URLSearchParams(window.location.search).get('lang');
  if (isLocale(queryLocale)) return queryLocale;
  try {
    const saved = localStorage.getItem(localeStorageKey);
    if (isLocale(saved)) return saved;
  } catch {
    // Browser language and URL selection still work when storage is unavailable.
  }
  return resolvePreferredLocale(navigator.languages);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // Keep the static export and initial hydration identical on every browser.
  const [locale, updateLocale] = useState<Locale>(defaultLocale);
  useEffect(() => {
    const restore = () => updateLocale(preferredLocale());
    restore();
    window.addEventListener('popstate', restore);
    window.addEventListener('storage', restore);
    return () => {
      window.removeEventListener('popstate', restore);
      window.removeEventListener('storage', restore);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title =
      locale === 'en' ? 'ZeroSE · Your connected assistant' : 'ZeroSE · Tu asistente, conectado';
  }, [locale]);
  const value = useMemo(
    () => ({
      locale,
      translate: createTranslator(locale),
      setLocale(next: Locale) {
        if (!isLocale(next)) return;
        try {
          localStorage.setItem(localeStorageKey, next);
        } catch {
          /* URL remains the preference. */
        }
        const url = new URL(window.location.href);
        url.searchParams.set('lang', next);
        window.history.pushState(null, '', url);
        updateLocale(next);
      },
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used within I18nProvider');
  return value;
}
export function useTranslations() {
  return useI18n().translate;
}
export function useLocale() {
  return useI18n().locale;
}
