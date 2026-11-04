import assert from 'node:assert/strict';
import test from 'node:test';
import { renderUserPrompt } from '../src/application/prompts.js';

const facts = { now: '4/11/2026, 12:00:00', timezone: 'Europe/Madrid', name: 'Alex', context: '' };

test('runtime facts are supplied without placeholders and empty context has no section', () => {
  const instructions = renderUserPrompt('Personal instructions.', facts);
  assert.match(instructions, /^Personal instructions\./);
  assert.match(instructions, /Fecha y hora actuales: 4\/11\/2026, 12:00:00/);
  assert.match(instructions, /Zona horaria: Europe\/Madrid/);
  assert.match(instructions, /Nombre del usuario: Alex/);
  assert(!instructions.includes('Contexto del usuario'));
  assert(!renderUserPrompt('', { ...facts, context: ' \n ' }).includes('Contexto del usuario'));
});

test('each render uses only the supplied profile context and does not expand old variables', () => {
  const template = '{{name}} {{now}} {{timezone}} {{context}} {{identity}}';
  const first = renderUserPrompt(template, { ...facts, context: 'First profile' });
  const second = renderUserPrompt('', { ...facts, name: 'Sam', context: 'Second profile' });
  assert(first.startsWith(template));
  assert.match(first, /Contexto del usuario o grupo \(datos de este perfil\):\nFirst profile/);
  assert.match(second, /Nombre del usuario: Sam/);
  assert.match(second, /Second profile/);
  assert(!second.includes('First profile'));
});
