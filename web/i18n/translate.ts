import type { Locale } from './config';
import { english } from './messages';
export function createTranslator(locale: Locale) {
  return Object.assign(
    (message = '', values?: Record<string, string | number>): string => {
      const resolved =
        locale === 'en' ? (Object.hasOwn(english, message) ? english[message]! : message) : message;
      return resolved.replace(/\{(\w+)\}/g, (match, token: string) => {
        const value = values?.[token];
        return value === undefined ? match : String(value);
      });
    },
    { locale },
  );
}
