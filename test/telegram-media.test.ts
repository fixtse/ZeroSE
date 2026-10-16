import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import { Media } from '../src/adapters/outbound/media.js';
import { Telegram } from '../src/adapters/outbound/telegram.js';
import { ProcessMessage } from '../src/application/use-cases/process-message.js';
import type {
  AgentPort,
  ConversationStore,
  GooglePort,
  TelegramPort,
} from '../src/application/ports.js';

test('Telegram returns transcripts for videos and forwarded audio while direct audio remains a request', async () => {
  const config = ConfigSchema.parse({ telegram: { token: 'test-only' } });
  let extractedMime = '';
  class TestMedia extends Media {
    async download() {
      return Buffer.from('test media');
    }
    async extract(_buffer: Buffer, _filename: string, mime: string) {
      extractedMime = mime;
      return { text: 'Exact transcript', images: [] };
    }
  }
  class TestTelegram extends Telegram {
    async call(method: string, body: any) {
      assert.equal(method, 'getFile');
      assert.equal(body.file_id, 'file');
      return { file_path: 'media/file' };
    }
  }
  const telegram = new TestTelegram(config, new TestMedia(config));
  const file = { file_id: 'file' };
  const cases = [
    { message: { video: file }, only: true, mime: 'video/mp4' },
    {
      message: { video: file, forward_origin: { type: 'channel' } },
      only: true,
      mime: 'video/mp4',
    },
    { message: { video_note: file }, only: true, mime: 'video/mp4' },
    { message: { voice: file }, only: false, mime: 'audio/ogg' },
    { message: { audio: file }, only: false, mime: 'audio/mpeg' },
    {
      message: { voice: file, forward_origin: { type: 'hidden_user' } },
      only: true,
      mime: 'audio/ogg',
    },
    { message: { audio: file, forward_origin: { type: 'user' } }, only: true, mime: 'audio/mpeg' },
    { message: { audio: file, forward_date: 123 }, only: true, mime: 'audio/mpeg' },
    { message: { reply_to_message: { audio: file } }, only: true, mime: 'audio/mpeg' },
    { message: { external_reply: { video: file } }, only: true, mime: 'video/mp4' },
    {
      message: { document: { ...file, mime_type: 'video/quicktime' } },
      only: true,
      mime: 'video/quicktime',
    },
    {
      message: { document: { ...file, mime_type: 'audio/flac' }, forward_origin: { type: 'user' } },
      only: true,
      mime: 'audio/flac',
    },
  ];
  for (const { message, only, mime } of cases) {
    const result = await telegram.input(
      { ...message, caption: 'Caption is not spoken audio' },
      'media-test',
      new AbortController().signal,
    );
    assert.equal(result.transcriptionOnly, only, JSON.stringify(message));
    assert.equal(extractedMime, mime);
    assert.equal(
      result.text,
      only ? 'Exact transcript' : 'Caption is not spoken audio\n\nExact transcript',
    );
    assert.deepEqual(result.images, []);
  }
});

test('video uses the configured extraction service before STT and direct audio bypasses extraction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zero-media-test-'));
  const requests: string[] = [];
  const video = Buffer.from('video bytes sent unchanged');
  const wav = Buffer.from('RIFF test WAV bytes');
  let extractionStatus = 200;
  let extractedAudio = wav;
  const received: { mime: string; buffer: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url!);
    assert.equal(req.method, 'POST');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = await new Response(Buffer.concat(chunks), {
      headers: { 'Content-Type': req.headers['content-type']! },
    }).formData();
    if (req.url === '/video/extract/audio') {
      const file = body.get('file') as File;
      assert.equal(file.name, 'clip.mp4');
      assert.equal(file.type, 'video/mp4');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), video);
      res.writeHead(extractionStatus, { 'Content-Type': 'audio/wav' });
      res.end(extractedAudio);
      return;
    }
    assert.equal(req.url, '/configured-stt?output=json');
    const file = body.get('audio_file') as File;
    received.push({ mime: file.type, buffer: Buffer.from(await file.arrayBuffer()) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: 'Verbatim STT result.' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const config = ConfigSchema.parse({
    dataDir: dir,
    media: {
      asrUrl: base + '/configured-stt?output=json',
      audioExtractionUrl: base + '/video/extract/audio',
      maxBytes: 100,
    },
  });
  const media = new Media(config);
  const signal = new AbortController().signal;
  const extractVideo = () => media.extract(video, 'clip.mp4', 'video/mp4', 'video', signal);
  try {
    assert.deepEqual(await extractVideo(), { text: 'Verbatim STT result.', images: [] });
    assert.deepEqual(requests, ['/video/extract/audio', '/configured-stt?output=json']);
    assert.deepEqual(received, [{ mime: 'audio/wav', buffer: wav }]);
    assert.deepEqual(await media.extract(wav, 'audio.wav', 'audio/wav', 'audio', signal), {
      text: 'Verbatim STT result.',
      images: [],
    });
    assert.deepEqual(requests, [
      '/video/extract/audio',
      '/configured-stt?output=json',
      '/configured-stt?output=json',
    ]);
    assert.deepEqual(received[1], received[0]);

    extractionStatus = 503;
    await assert.rejects(extractVideo, /Audio extraction returned HTTP 503/);
    extractionStatus = 200;
    extractedAudio = Buffer.alloc(0);
    await assert.rejects(extractVideo, /returned no audio/);
    extractedAudio = Buffer.alloc(101);
    await assert.rejects(extractVideo, /size limit/);
    assert.equal(received.length, 2, 'Failed extraction must not call STT');
    assert.equal(
      requests.filter((path) => path === '/video/extract/audio').length,
      4,
      'Failed extraction must not be retried',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('transcription replies bypass commands, the agent, conversation storage and voice synthesis', async () => {
  function unused<T extends object>(): T {
    return new Proxy({} as T, {
      get(_target, key) {
        throw new Error(`Transcription must not access ${String(key)}`);
      },
    });
  }
  for (const text of ['Exact transcript', '/clean', '/nuevo']) {
    const telegram: TelegramPort = {
      async input() {
        return { text, images: [], transcriptionOnly: true };
      },
      async send() {},
      async sendVoice() {
        throw new Error('Must not synthesize a transcription');
      },
      async typing() {},
    };
    const process = new ProcessMessage(
      ConfigSchema.parse({}),
      unused<ConversationStore>(),
      unused<AgentPort>(),
      unused<GooglePort>(),
      telegram,
      '',
    );
    assert.deepEqual(
      await process.execute(
        {
          id: 'media',
          session: 'test',
          status: 'running',
          payload: { kind: 'telegram', message: {} },
        },
        { session: 'test', jobId: 'media', signal: new AbortController().signal },
      ),
      { output: text, voice: false },
    );
  }
});
