import { defaultLocale, isLocale } from './config';
import { createTranslator } from './translate';
/** Resolve built-in client notices at delivery time, including asynchronous failures. */
export function translateNotice(message: string): string {
  const lang = typeof document === 'undefined' ? defaultLocale : document.documentElement.lang;
  return createTranslator(isLocale(lang) ? lang : defaultLocale)(message);
}
