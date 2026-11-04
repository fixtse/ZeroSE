import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolvePreferredLocale, isLocale } = require('../web/i18n/config.js') as {
  resolvePreferredLocale(languages: readonly string[]): 'en' | 'es';
  isLocale(value: unknown): boolean;
};
const { createTranslator } = require('../web/i18n/translate.js') as {
  createTranslator(
    locale: 'en' | 'es',
  ): (message: string, values?: Record<string, string | number>) => string;
};

test('admin localization resolves regional browser preferences and rejects unsupported locales', () => {
  assert.equal(resolvePreferredLocale(['fr-FR', 'es-MX', 'en-US']), 'es');
  assert.equal(resolvePreferredLocale(['en-GB', 'es-ES']), 'en');
  assert.equal(resolvePreferredLocale(['ES-es']), 'es');
  assert.equal(resolvePreferredLocale(['fr-FR']), 'en');
  assert.equal(resolvePreferredLocale([]), 'en');
  for (const value of [null, undefined, '', 'en-US', 'fr', '__proto__'])
    assert.equal(isLocale(value), false);
});

test('admin translations preserve unknown text and interpolate values without translating them', () => {
  const en = createTranslator('en');
  const es = createTranslator('es');
  assert.equal(en('Usuarios'), 'Users');
  assert.equal(es('Usuarios'), 'Usuarios');
  assert.equal(en('Custom user content'), 'Custom user content');
  assert.equal(en('__proto__'), '__proto__');
  assert.equal(en('constructor'), 'constructor');
  assert.equal(
    en('Generando avatar de {name}…', { name: 'Usuarios' }),
    'Generating avatar for Usuarios…',
  );
  assert.equal(es('Generando avatar de {name}…', { name: 'Ana' }), 'Generando avatar de Ana…');
  assert.equal(en('{count} recuerdos reprocesados.', { count: 3 }), '3 memories reprocessed.');
  assert.equal(en('{count} recuerdos reprocesados.'), '{count} memories reprocessed.');
});
