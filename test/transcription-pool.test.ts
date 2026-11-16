import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { Media } from '../src/adapters/outbound/media.js';
import { RemoteError } from '../src/adapters/outbound/http.js';
import {
  balanced,
  resetTranscriptionPool,
  sourceCooldownMs,
  transcriptionSources,
  TranscriptionUnavailableError,
} from '../src/adapters/outbound/transcription-pool.js';
import { ServiceSettingsAdmin } from '../src/adapters/inbound/service-settings-admin.js';
import { serviceConfig, type ServiceConfig } from '../src/application/service-settings.js';

const signal = new AbortController().signal;

test('transcription sources merge the primary URL with unique additional sources', () => {
  assert.deepEqual(transcriptionSources(' http://a/t ', ['http://b/t', 'http://a/t', ' ']), [
    'http://a/t',
    'http://b/t',
  ]);
  assert.deepEqual(transcriptionSources('', []), []);
});

test('balanced rotates sources round robin', async () => {
  resetTranscriptionPool();
  const sources = ['http://a', 'http://b', 'http://c'];
  const used: string[] = [];
  for (let index = 0; index < 4; index++)
    used.push(await balanced(sources, signal, async (url) => url));
  assert.deepEqual(used, ['http://a', 'http://b', 'http://c', 'http://a']);
});

test('balanced fails over once per source and cools down failed sources', async () => {
  resetTranscriptionPool();
  let time = 1_000;
  const sources = ['http://a', 'http://b'];
  const attempts: string[] = [];
  const result = await balanced(
    sources,
    signal,
    async (url) => {
      attempts.push(url);
      if (url === 'http://a') throw new TypeError('fetch failed');
      return 'ok:' + url;
    },
    () => time,
  );
  assert.equal(result, 'ok:http://b');
  assert.deepEqual(attempts, ['http://a', 'http://b']);
  // The next rotation would start at b; a is still cooling down so it stays last.
  attempts.length = 0;
  resetTranscriptionPool();
  await assert.rejects(
    balanced(sources, signal, async (url) => {
      attempts.push(url);
      throw new RemoteError('Speech transcription', 503);
    }),
    RemoteError,
  );
  assert.deepEqual(attempts, ['http://a', 'http://b']);
  // A cooled-down source is ordered after healthy ones until the cooldown expires.
  attempts.length = 0;
  resetTranscriptionPool();
  await assert.rejects(
    balanced(
      ['http://x', 'http://y'],
      signal,
      async (url) => {
        attempts.push(url);
        throw new RemoteError('Speech transcription', url === 'http://x' ? 500 : 400);
      },
      () => time,
    ),
  );
  attempts.length = 0;
  await balanced(
    ['http://x', 'http://y'],
    signal,
    async (url) => {
      attempts.push(url);
      return url;
    },
    () => time,
  );
  assert.deepEqual(attempts, ['http://y']);
  time += sourceCooldownMs + 1;
  attempts.length = 0;
  await balanced(
    ['http://x', 'http://y'],
    signal,
    async (url) => url,
    () => time,
  );
});

test('balanced does not fail over client errors or aborted requests', async () => {
  resetTranscriptionPool();
  const attempts: string[] = [];
  await assert.rejects(
    balanced(['http://a', 'http://b'], signal, async (url) => {
      attempts.push(url);
      throw new RemoteError('Speech transcription', 415);
    }),
    RemoteError,
  );
  assert.deepEqual(attempts, ['http://a']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(balanced(['http://a'], controller.signal, async () => 'never'));
  await assert.rejects(
    balanced([], signal, async () => 'never'),
    TranscriptionUnavailableError,
  );
});

test('media transcription can be disabled and load balances ClipSE sources', async (t) => {
  resetTranscriptionPool();
  const audio = Buffer.from('voice');
  const disabled = new Media(
    ConfigSchema.parse({ media: { asrProvider: 'none', asrUrl: 'http://kept/transcribe' } }),
  );
  await assert.rejects(
    disabled.transcribe(audio, 'audio/ogg', signal),
    TranscriptionUnavailableError,
  );
  await assert.rejects(
    new Media(ConfigSchema.parse({})).transcribe(audio, 'audio/ogg', signal),
    TranscriptionUnavailableError,
  );
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    urls.push(url);
    assert.ok((options.body as FormData).get('file'));
    if (url === 'http://down/transcribe') throw new TypeError('fetch failed');
    return Response.json({ text: 'hola from ' + url });
  });
  const media = new Media(
    ConfigSchema.parse({
      media: {
        asrProvider: 'clipse-whisper',
        asrUrl: 'http://one/transcribe',
        asrUrls: ['http://down/transcribe', 'http://two/transcribe'],
      },
    }),
  );
  assert.equal(
    await media.transcribe(audio, 'audio/ogg', signal),
    'hola from http://one/transcribe',
  );
  assert.equal(
    await media.transcribe(audio, 'audio/ogg', signal),
    'hola from http://two/transcribe',
  );
  assert.deepEqual(urls, [
    'http://one/transcribe',
    'http://down/transcribe',
    'http://two/transcribe',
  ]);
  assert.throws(() => ConfigSchema.parse({ media: { asrUrls: ['ftp://nope/transcribe'] } }));
});

function onboardingFixture() {
  let value = serviceConfig(ConfigSchema.parse({}));
  let revision = 1;
  const applied: ServiceConfig[] = [];
  const admin = new ServiceSettingsAdmin(
    {
      initialize: async () => {},
      read: async () => ({ revision, value }),
      update: async (expected, next) => {
        if (expected !== revision) return false;
        value = next;
        revision++;
        return true;
      },
    },
    async (next) => {
      applied.push(structuredClone(next));
    },
  );
  async function request(method: string, body?: unknown, path = '/v1/admin/setup/onboarding') {
    let status = 0;
    let result: any;
    await admin.handle(
      { method } as IncomingMessage,
      path,
      async () => body,
      (code, next) => {
        status = code;
        result = next;
      },
    );
    return { status, result };
  }
  return { request, value: () => value, applied };
}

test('onboarding stores the chosen channels, transcription sources and completion', async () => {
  const f = onboardingFixture();
  const initial = await f.request('GET');
  assert.equal(initial.status, 200);
  assert.deepEqual(
    { mode: initial.result.mode, completed: initial.result.completed },
    { mode: '', completed: false },
  );
  assert.equal(initial.result.transcription, 'none');
  assert.equal((await f.request('PUT', { revision: 1, mode: 'both' })).status, 200);
  assert.equal(f.value().setup?.mode, 'both');
  const missing = await f.request('PUT', {
    revision: 2,
    transcription: { provider: 'clipse-whisper', urls: [] },
  });
  assert.equal(missing.status, 400);
  const saved = await f.request('PUT', {
    revision: 2,
    transcription: {
      provider: 'clipse-whisper',
      urls: ['http://a:8000/transcribe', 'http://b:8000/transcribe', 'http://a:8000/transcribe'],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(f.value().media.asrUrl, 'http://a:8000/transcribe');
  assert.deepEqual(f.value().media.asrUrls, ['http://b:8000/transcribe']);
  const status = (await f.request('GET')).result;
  assert.equal(status.transcription, 'clipse-whisper');
  assert.equal(status.transcriptionSources, 2);
  // Turning transcription off keeps the saved sources for later.
  await f.request('PUT', { revision: 3, transcription: { provider: 'none', urls: [] } });
  assert.equal(f.value().media.asrProvider, 'none');
  assert.equal(f.value().media.asrUrl, 'http://a:8000/transcribe');
  assert.equal((await f.request('PUT', { revision: 4, completed: true })).status, 200);
  assert.deepEqual(f.value().setup, { mode: 'both', completed: true });
  assert.equal((await f.request('PUT', { revision: 1, completed: false })).status, 409);
  assert.equal(f.applied.length, 4);
  // The wizard state never appears in the generic settings editor.
  const services = await f.request('GET', undefined, '/v1/admin/setup/services');
  assert.ok(!services.result.fields.some((field: any) => field.path.startsWith('setup.')));
  assert.ok(services.result.fields.some((field: any) => field.path === 'media.asrUrls'));
});
