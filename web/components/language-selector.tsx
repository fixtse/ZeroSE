'use client';
import { useI18n } from '../i18n/provider';
import { locales } from '../i18n/config';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

/** Same two-state button selector as ScribeSE's LocaleSwitcher. */
export function LanguageSelector() {
  const { locale, setLocale } = useI18n();
  return (
    <div
      className="language-selector inline-flex rounded-md border border-border p-0.5"
      role="group"
      aria-label={locale === 'en' ? 'Interface language' : 'Idioma de la interfaz'}
    >
      {locales.map((language) => (
        <Button
          key={language}
          type="button"
          className={cn(
            'h-7 min-w-10 px-2 text-xs uppercase',
            language === locale && 'pointer-events-none',
          )}
          onClick={() => {
            if (language !== locale) setLocale(language);
          }}
          size="sm"
          title={language === 'en' ? 'English' : 'Español'}
          aria-pressed={language === locale}
          variant={language === locale ? 'default' : 'ghost'}
          lang={language}
        >
          {language}
        </Button>
      ))}
    </div>
  );
}
