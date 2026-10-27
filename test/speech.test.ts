import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomeAssistantSpeech } from '../src/adapters/outbound/home-assistant-speech.js';
import type { Config } from '../src/domain/config.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { Media } from '../src/adapters/outbound/media.js';
import { scopedConfig } from '../src/application/access.js';
import type { AccessProfile } from '../src/domain/access.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { fixture } from './helpers.js';

const speech = {
  stt: 'stt.microsoft',
  sttLanguage: 'es-ES',
  tts: 'tts.microsoft',
  ttsLanguage: 'es-ES',
  voice: 'es-ES-ElviraNeural',
};
const profile: AccessProfile = {
  bot: 'helper',
  chatId: '123',
  kind: 'user',
  label: 'Speech user',
  enabled: true,
  owner: false,
  capabilities: ['homeAssistant', 'transcription'],
  speech,
};
const query = { search: '', offset: 0, limit: 50 };
const signal = () => AbortSignal.timeout(5000);

test('HA speech catalogs authenticate, filter and paginate engines and voices, and handle failures and cancellation', async (t) => {
  let sockets = 0;
  let mode = 'success';
  class FakeSocket {
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: URL) {
      sockets++;
      assert.equal(url.href, 'ws://ha.test/api/websocket');
      queueMicrotask(() => this.message({ type: 'auth_required' }));
    }
    message(value: unknown) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
    send(raw: string) {
      const input = JSON.parse(raw);
      if (input.type === 'auth') {
        assert.equal(input.access_token, 'private-token');
        queueMicrotask(() => this.message({ type: mode === 'auth' ? 'auth_invalid' : 'auth_ok' }));
      } else if (mode !== 'wait')
        queueMicrotask(() =>
          this.message({
            type: 'result',
            id: 1,
            success: mode !== 'error',
            result:
              input.type === 'tts/engine/voices'
                ? {
                    voices: [
                      { voice_id: 'elvira', name: 'Elvira' },
                      { voice_id: 'alvaro', name: 'Álvaro' },
                    ],
                  }
                : {
                    providers: [
                      { engine_id: 'tts.microsoft', supported_languages: ['es-ES'] },
                      { engine_id: 'tts.other', name: 'Other' },
                    ],
                  },
          }),
        );
    }
    close() {
      sockets--;
    }
  }
  t.mock.method(globalThis, 'WebSocket', function (url: URL) {
    return new FakeSocket(url);
  } as any);
  const ha = new HomeAssistantSpeech({
    ...ConfigSchema.parse({}).homeAssistant,
    url: 'http://ha.test',
    token: 'private-token',
  });
  assert.deepEqual(await ha.engines('tts', { ...query, search: 'MICROSOFT' }, signal()), {
    items: [{ id: 'tts.microsoft', name: 'tts.microsoft', languages: ['es-ES'] }],
    total: 1,
  });
  assert.deepEqual(
    await ha.voices('tts.microsoft', 'es-ES', { ...query, offset: 1, limit: 1 }, signal()),
    { items: [{ id: 'alvaro', name: 'Álvaro' }], total: 2 },
  );
  mode = 'error';
  await assert.rejects(ha.engines('stt', query, signal()), /unavailable/);
  mode = 'auth';
  await assert.rejects(ha.engines('stt', query, signal()), /authentication/);
  mode = 'wait';
  const controller = new AbortController();
  const pending = ha.engines('stt', query, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(sockets, 0);
  await assert.rejects(ha.engines('stt', query, controller.signal), /abort/i);
});

test('HA speech normalizes incoming audio to PCM and returns selected voice as Telegram Opus without invoking defaults', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-ha-speech-'));
  const config: Config = ConfigSchema.parse({
    dataDir: dir,
    homeAssistant: { url: 'http://ha.test', token: 'private-token' },
  });
  config.media.speech = speech;
  const originalPath = process.env.PATH;
  await writeFile(
    join(dir, 'ffmpeg'),
    `#!${process.execPath}\nconst fs=require('node:fs');const assert=require('node:assert/strict');const args=process.argv.slice(2);if(args.includes('s16le')){assert.equal(args[args.indexOf('-ar')+1],'16000');assert.equal(args[args.indexOf('-ac')+1],'1');fs.writeFileSync(args.at(-1),'raw pcm');}else{assert.equal(fs.readFileSync(args[args.indexOf('-i')+1],'utf8'),'ha audio');assert.equal(args[args.indexOf('-c:a')+1],'libopus');fs.writeFileSync(args.at(-1),'OggS test');}`,
    { mode: 0o700 },
  );
  process.env.PATH = dir;
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push(url);
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer private-token');
    if (url.endsWith('/api/stt/stt.microsoft')) {
      assert.equal(Buffer.from(init.body as Uint8Array).toString(), 'raw pcm');
      assert.equal(
        (init.headers as Record<string, string>)['X-Speech-Content'],
        'format=wav; codec=pcm; sample_rate=16000; bit_rate=16; channel=1; language=es-ES',
      );
      return Response.json({ result: 'success', text: 'Hola, mundo' });
    }
    if (url.endsWith('/api/tts_get_url')) {
      assert.deepEqual(JSON.parse(init.body as string), {
        engine_id: speech.tts,
        message: 'Hola',
        language: 'es-ES',
        cache: false,
        options: { voice: speech.voice },
      });
      return Response.json({ path: '/api/tts_proxy/test.mp3', url: 'http://untrusted.test/audio' });
    }
    assert.equal(url, 'http://ha.test/api/tts_proxy/test.mp3');
    assert.equal(init.redirect, 'error');
    return new Response('ha audio');
  });
  try {
    const media = new Media(config);
    assert.equal(
      await media.transcribe(Buffer.from('compressed incoming audio'), 'audio/ogg', signal()),
      'Hola, mundo',
    );
    assert.equal((await media.voice('**Hola**', 'job', signal())).toString(), 'OggS test');
    assert.equal(requests.length, 3);
    await media.cleanup('job');
    assert.deepEqual(await readdir(join(dir, 'media')), []);
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('HA speech rejects error results, external audio paths, oversized and empty audio without retrying', async (t) => {
  const ha = new HomeAssistantSpeech(
    { ...ConfigSchema.parse({}).homeAssistant, url: 'http://ha.test', token: 'secret' },
    5,
  );
  let calls = 0;
  let result: unknown = { result: 'error', text: null };
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json(result);
  });
  await assert.rejects(
    ha.transcribe(Buffer.from('pcm'), speech.stt, 'es-ES', signal()),
    /transcription failed/,
  );
  assert.equal(calls, 1);
  result = { path: 'https://untrusted.test/private' };
  await assert.rejects(
    ha.synthesize('Hola', speech.tts, 'es-ES', speech.voice, signal()),
    /invalid.*path/,
  );
  assert.equal(calls, 2);
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    url.endsWith('tts_get_url')
      ? Response.json({ path: '/api/tts_proxy/test' })
      : new Response('too much audio'),
  );
  await assert.rejects(ha.synthesize('Hola', speech.tts, 'es-ES', '', signal()), /size limit/);
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    url.endsWith('tts_get_url') ? Response.json({ path: '/api/tts_proxy/test' }) : new Response(''),
  );
  await assert.rejects(ha.synthesize('Hola', speech.tts, 'es-ES', '', signal()), /empty/);
});

test('speech preferences persist per profile, survive migration, and admin discovery and preview use scoped credentials', async () => {
  const f = await fixture();
  try {
    const repository = new PostgresAccess(f.store.db, f.config.apiKey);
    await repository.initialize(f.config);
    const homeAssistant = {
      ...f.config.homeAssistant,
      url: 'http://private-ha.test',
      token: 'private-ha-token',
    };
    await repository.saveProfile({ ...profile, homeAssistant });
    const saved = (await repository.profile('helper', '123'))!;
    assert.deepEqual(saved.speech, speech);
    assert.deepEqual(scopedConfig(f.config, saved).media.speech, speech);
    assert.equal(scopedConfig(f.config, { ...saved, capabilities: [] }).homeAssistant.token, '');
    assert.equal(scopedConfig(f.config, { ...profile, owner: false }).homeAssistant.token, '');
    const stored = (
      await f.store.pool.query('SELECT credentials FROM access_profiles WHERE chat_id=$1', ['123'])
    ).rows[0].credentials;
    assert(!stored.includes('Elvira') && !stored.includes('private-ha-token'));
    await repository.saveProfile({ ...saved, chatId: '-123', kind: 'group' });
    await repository.migrateGroup('helper', '-123', '-456');
    assert.deepEqual((await repository.profile('helper', '-456'))?.speech, speech);
    let previews = 0;
    const admin = new Admin(
      f.config,
      repository,
      async () => {},
      undefined,
      undefined,
      (scoped) => {
        assert.equal(scoped.homeAssistant.token, homeAssistant.token);
        return {
          async engines(kind, q) {
            assert.equal(kind, 'tts');
            assert.equal(q.limit, 1);
            return {
              items: [{ id: 'tts.microsoft', name: 'Microsoft', languages: ['es-ES'] }],
              total: 1,
            };
          },
          async voices() {
            return { items: [], total: 0 };
          },
          async synthesize() {
            throw new Error('unused');
          },
        };
      },
      async (scoped, text) => {
        previews++;
        assert.deepEqual(scoped.media.speech, speech);
        assert.equal(text, 'Hola editable');
        return Buffer.from('OggS preview');
      },
    );
    const request = async (action: string, body: unknown) => {
      let status = 0,
        value: any;
      await admin.handle(
        { method: 'POST' } as any,
        '/v1/admin/profiles/helper/123/speech/' + action,
        async () => body,
        (s, v) => {
          status = s;
          value = v;
        },
      );
      return { status, value };
    };
    assert.equal((await request('catalog', { kind: 'tts', limit: 1 })).status, 200);
    const preview = await request('preview', { speech, text: 'Hola editable' });
    assert.equal(preview.status, 200);
    assert.equal(Buffer.from(preview.value.audio, 'base64').toString(), 'OggS preview');
    assert.equal(previews, 1);
    assert.deepEqual((await repository.profile('helper', '123'))?.speech, speech);
    await repository.saveProfile({ ...saved, capabilities: ['transcription'] });
    assert.equal((await request('preview', { speech, text: 'Hola editable' })).status, 400);
    assert.equal((await request('catalog', { kind: 'tts' })).status, 400);
    assert.equal(previews, 1);
  } finally {
    await f.close();
  }
});

test('Zero and Helper route both incoming transcription and voice replies through the current chat preferences', async (t) => {
  const { Access } = await import('../src/application/access.js');
  const { TelegramBots } = await import('../src/adapters/inbound/telegram-bots.js');
  const { Telegram } = await import('../src/adapters/outbound/telegram.js');
  const f = await fixture();
  try {
    f.config.telegram.token = 'zero-token';
    const repository = new PostgresAccess(f.store.db, f.config.apiKey);
    await repository.initialize(f.config);
    await repository.saveBot({ id: 'helper', enabled: true, token: 'helper-token' });
    const homeAssistant = {
      ...f.config.homeAssistant,
      url: 'http://ha.test',
      token: 'chat-private-token',
    };
    for (const bot of ['zero', 'helper'] as const)
      await repository.saveProfile({ ...profile, bot, homeAssistant });
    const media = new Media(f.config),
      zero = new Telegram(f.config, media);
    const bots = new TelegramBots(f.config, media, zero, f.store, new Access(repository, f.store));
    t.mock.method(Telegram.prototype, 'call', async (method: string) => {
      assert(['getFile', 'sendVoice'].includes(method));
      return { file_path: 'voice.ogg' };
    });
    t.mock.method(Media.prototype, 'download', async () => Buffer.from('audio'));
    const seen: unknown[] = [];
    t.mock.method(Media.prototype, 'transcribe', async function (this: any) {
      seen.push(this.config.media.speech);
      assert.equal(this.config.homeAssistant.token, homeAssistant.token);
      return 'Transcripción';
    });
    t.mock.method(Media.prototype, 'voice', async function (this: any) {
      seen.push(this.config.media.speech);
      return Buffer.from('OggS');
    });
    for (const bot of ['zero', 'helper'] as const) {
      const telegram = await bots.get(bot, (bot === 'zero' ? 'telegram:' : 'helper:') + '123');
      assert.equal(
        (await telegram.input({ voice: { file_id: '1' } }, 'test-job', signal())).text,
        'Transcripción',
      );
      await telegram.sendVoice('123', 'Hola', 'test-job', signal());
    }
    assert.deepEqual(seen, [speech, speech, speech, speech]);
    await repository.saveProfile({
      ...profile,
      bot: 'zero',
      homeAssistant,
      speech: { ...speech, stt: 'default', tts: 'default', voice: '' },
    });
    const updated = await bots.get('zero', 'telegram:123');
    await updated.sendVoice('123', 'Hola', 'test-job', signal());
    assert.equal((seen.at(-1) as typeof speech).tts, 'default');
    const unscoped = await bots.get('zero');
    assert(unscoped instanceof Telegram);
    await unscoped.sendVoice('123', 'Hola', 'test-job', signal());
    assert.equal(seen.at(-1), undefined);
  } finally {
    await f.close();
  }
});
