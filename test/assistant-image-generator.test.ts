import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderAssistantImageGenerator } from '../src/adapters/outbound/assistant-image-generator.js';
import type { AISettings, AISettingsPort } from '../src/domain/ai.js';

test('avatar generation follows the current default and never substitutes an image model', async () => {
  const settings: AISettings = {
    revision: 1,
    defaultModel: 'text',
    providers: [{ id: 'p', name: '', kind: 'openrouter', apiKey: 'private', baseUrl: '' }],
    models: [
      { id: 'text', label: '', provider: 'p', model: 'text' },
      { id: 'image', label: '', provider: 'p', model: 'image' },
    ],
  };
  let generations = 0;
  const generator = new ProviderAssistantImageGenerator(
    { read: async () => settings } as AISettingsPort,
    async (url, options) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          data: [
            { id: 'text', architecture: { output_modalities: ['text'] } },
            { id: 'image', architecture: { output_modalities: ['text', 'image'] } },
          ],
        });
      generations++;
      assert.equal(JSON.parse(String(options?.body)).model, 'image');
      return Response.json({
        choices: [
          { message: { images: [{ image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] } },
        ],
      });
    },
  );
  assert.equal(await generator.available(), false);
  await assert.rejects(generator.generate('avatar', AbortSignal.timeout(1000)));
  assert.equal(generations, 0);
  settings.defaultModel = 'image';
  assert.equal(await generator.available(), true);
  assert.equal(
    await generator.generate('avatar', AbortSignal.timeout(1000)),
    'data:image/png;base64,aGVsbG8=',
  );
  assert.equal(generations, 1);
  settings.defaultModel = 'text';
  await assert.rejects(generator.generate('avatar', AbortSignal.timeout(1000)));
  assert.equal(generations, 1);
});

test('Codex default uses isolated avatar generation without an HTTP fallback', async () => {
  const settings = {
    revision: 1,
    defaultModel: 'default',
    providers: [{ id: 'codex', name: '', kind: 'codex', apiKey: '', baseUrl: '' }],
    models: [{ id: 'default', label: '', provider: 'codex', model: 'gpt-5.4' }],
  } as AISettings;
  let calls = 0;
  const generator = new ProviderAssistantImageGenerator(
    { read: async () => settings } as AISettingsPort,
    async () => {
      throw new Error('Unexpected HTTP request');
    },
    async (model, prompt) => {
      calls++;
      assert.equal(model, 'gpt-5.4');
      assert.equal(prompt, 'A cat');
      return 'data:image/png;base64,aGVsbG8=';
    },
  );
  assert.equal(await generator.available(), true);
  assert.equal(
    await generator.generate('A cat', AbortSignal.timeout(1000)),
    'data:image/png;base64,aGVsbG8=',
  );
  assert.equal(calls, 1);
});

test('reference images reach the selected OpenRouter, OpenAI and Codex generators', async () => {
  const reference = 'data:image/jpeg;base64,/9j/2Q==';
  const settings = {
    revision: 1,
    defaultModel: 'image',
    providers: [{ id: 'p', name: '', kind: 'openrouter', apiKey: 'private', baseUrl: '' }],
    models: [{ id: 'image', label: '', provider: 'p', model: 'image' }],
  } as AISettings;
  const requests: { url: string; body: any }[] = [];
  const generator = new ProviderAssistantImageGenerator(
    { read: async () => settings } as AISettingsPort,
    async (url, options) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          data: [{ id: 'image', architecture: { output_modalities: ['image'] } }],
        });
      requests.push({ url: String(url), body: JSON.parse(String(options?.body)) });
      return Response.json({
        data: [{ b64_json: '/9j/2Q==' }],
        choices: [{ message: { images: [{ image_url: { url: reference } }] } }],
      });
    },
    async (model, prompt, _signal, references) => {
      assert.equal(model, 'gpt-5.4');
      assert.equal(prompt, 'A fox');
      assert.deepEqual(references, [reference]);
      return reference;
    },
  );
  const signal = AbortSignal.timeout(5000);
  await generator.generate('A fox', signal, [reference]);
  assert.deepEqual(requests[0].body.messages[0].content, [
    { type: 'text', text: 'A fox' },
    { type: 'image_url', image_url: { url: reference } },
  ]);
  settings.providers[0].kind = 'openai';
  settings.models[0].model = 'gpt-image-2';
  await generator.generate('A fox', signal, [reference]);
  assert(requests[1].url.endsWith('/images/edits'));
  assert.deepEqual(requests[1].body.images, [{ image_url: reference }]);
  assert.equal(requests[1].body.prompt, 'A fox');
  settings.providers[0].kind = 'codex';
  settings.models[0].model = 'gpt-5.4';
  assert.equal(await generator.generate('A fox', signal, [reference]), reference);
  assert.equal(requests.length, 2);
});
