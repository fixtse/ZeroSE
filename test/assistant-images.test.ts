import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresZeroSettings } from '../src/adapters/outbound/postgres-zero-settings.js';
import { PostgresAssistantDefinitions } from '../src/adapters/outbound/postgres-assistant-definitions.js';
import { PostgresAssistantImages } from '../src/adapters/outbound/postgres-assistant-images.js';
import { AssistantDefinitions } from '../src/application/assistant-definitions.js';
import { AssistantImageAdmin } from '../src/adapters/inbound/assistant-image-admin.js';
import { TelegramAssistantPhoto } from '../src/adapters/outbound/telegram-assistant-photo.js';

const image = 'data:image/jpeg;base64,/9j/2Q==';
test('assistant images have independent optimistic revisions and explicit Telegram publishing', async () => {
  const f = await fixture();
  try {
    await new PostgresAccess(f.store.db, f.config.apiKey).initialize(f.config);
    await new PostgresZeroSettings(f.store.db).initialize('Private prompt');
    const definitions = new AssistantDefinitions(
      new PostgresAssistantDefinitions(f.store.db),
      randomUUID,
    );
    const images = new PostgresAssistantImages(f.store.db);
    await images.initialize();
    let reads = 0,
      writes = 0;
    const admin = new AssistantImageAdmin(definitions, images, {
      available: async (id) => id === 'zero',
      get: async () => {
        reads++;
        return image;
      },
      set: async () => {
        writes++;
        throw new Error('Uncertain Telegram response');
      },
    });
    async function request(method: string, remote = false, body?: unknown) {
      let result: any;
      await admin.handle(
        { method } as IncomingMessage,
        '/v1/admin/setup/assistants/zero/image' + (remote ? '/telegram' : ''),
        async () => body,
        (status, value) => {
          result = { status, value };
        },
      );
      return result;
    }
    const before = await definitions.get('zero');
    assert.equal((await request('GET')).value.revision, 0);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.equal((await request('PUT', false, { image, revision: 0 })).status, 200);
    assert.equal((await request('PUT', false, { image: null, revision: 0 })).status, 409);
    assert.deepEqual(await definitions.get('zero'), before);
    assert(!JSON.stringify(await definitions.list('', 0, 20)).includes(image));
    await assert.rejects(request('POST', true, { image, confirm: false }));
    assert.equal(writes, 0);
    assert.equal((await request('POST', true, { image, confirm: true })).status, 502);
    assert.equal(writes, 1);
    assert.equal((await request('GET', true)).value.image, image);
    assert.equal(reads, 1);
    assert.equal((await request('PUT', false, { image: null, revision: 1 })).value.revision, 2);
    await assert.rejects(
      request('PUT', false, { image: 'data:image/svg+xml;base64,PHN2Zz4=', revision: 2 }),
    );
    assert.equal((await images.get('zero')).revision, 2);
  } finally {
    await f.close();
  }
});

test('Telegram profile photo reads keep credentials server-side; uncertain writes are submitted once', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    if (String(url).endsWith('/getMe')) return Response.json({ ok: true, result: { id: 123 } });
    if (String(url).endsWith('/getUserProfilePhotos'))
      return Response.json({ ok: true, result: { photos: [[{ file_id: 'photo-id' }]] } });
    if (String(url).endsWith('/getFile'))
      return Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg', file_size: 4 } });
    if (String(url).includes('/file/bot')) return new Response(Buffer.from([255, 216, 255, 217]));
    return new Response('{}', { status: 503 });
  };
  try {
    const photos = new TelegramAssistantPhoto(async (id) =>
      id === 'zero' ? 'fixture-secret-token' : undefined,
    );
    assert.equal(await photos.available('custom'), false);
    const result = await photos.get('zero', AbortSignal.timeout(1000));
    assert.equal(result, image);
    assert(!result?.includes('fixture-secret-token'));
    assert.equal(calls.length, 4);
    await assert.rejects(
      photos.set('zero', new Uint8Array([255, 216, 255, 217]), AbortSignal.timeout(1000)),
    );
    assert.equal(calls.length, 5);
    const form = calls[4].body as FormData;
    assert.deepEqual(JSON.parse(String(form.get('photo'))), {
      type: 'static',
      photo: 'attach://photo_file',
    });
    assert.equal((form.get('photo_file') as Blob).type, 'image/jpeg');
    await assert.rejects(photos.set('custom', new Uint8Array(), AbortSignal.timeout(1000)));
    assert.equal(calls.length, 5);
  } finally {
    globalThis.fetch = original;
  }
});

test('avatar generation validates bounded inline references without saving or publishing', async () => {
  let generations = 0;
  const admin = new AssistantImageAdmin(
    { get: async () => ({ id: 'zero' }) } as unknown as AssistantDefinitions,
    {
      get: async () => ({ image: null, revision: 0 }),
      save: async () => {
        throw new Error('Unexpected save');
      },
    },
    undefined,
    {
      available: async () => true,
      generate: async (prompt, _signal, references) => {
        generations++;
        assert.equal(prompt, 'A fox');
        assert.deepEqual(references, [image]);
        return image;
      },
    },
  );
  let result: unknown;
  const request = (body: unknown) =>
    admin.handle(
      { method: 'POST' } as IncomingMessage,
      '/v1/admin/setup/assistants/zero/image/generate',
      async () => body,
      (status, value) => {
        assert.equal(status, 200);
        result = value;
      },
    );
  await request({ prompt: ' A fox ', references: [image] });
  assert.deepEqual(result, { image });
  for (const references of [
    [image, image, image, image],
    ['https://example.com/private.jpg'],
    ['data:image/svg+xml;base64,PHN2Zz4='],
    ['x'.repeat(180001)],
  ]) {
    await assert.rejects(request({ prompt: 'A fox', references }));
  }
  assert.equal(generations, 1);
});
