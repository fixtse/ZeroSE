'use client';
import { Languages } from 'lucide-react';
import { useI18n } from '../i18n/provider';
import { isLocale } from '../i18n/config';
export function LanguageSelector() {
  const { locale, setLocale } = useI18n();
  return (
    <label className="language-selector">
      <Languages size={16} aria-hidden="true" />
      <span className="sr-only">
        {locale === 'en' ? 'Interface language' : 'Idioma de la interfaz'}
      </span>
      <select
        value={locale}
        onChange={(event) => {
          if (isLocale(event.target.value)) setLocale(event.target.value);
        }}
      >
        <option value="en" lang="en">
          English
        </option>
        <option value="es" lang="es">
          Español
        </option>
      </select>
    </label>
  );
}
