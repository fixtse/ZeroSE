import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import { Media } from '../src/adapters/outbound/media.js';
import { until } from './helpers.js';

test('voice synthesis uses the configured voice, validates audio, and stops on cancellation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-tts-test-'));
  const originalPath = process.env.PATH;
  const logs: string[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  const script = (body: string) => `#!${process.execPath}\n${body}`;
  await writeFile(
    join(dir, 'edge-tts'),
    script(`
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const text = args[args.indexOf('--text') + 1];
      fs.writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(args));
      if (text === 'fail private text') { console.error(text); process.exit(1); }
      if (text === 'wait') {
        fs.writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid));
        setInterval(() => {}, 1000);
      } else {
        fs.writeFileSync(args[args.indexOf('--write-media') + 1], text === 'empty' ? '' : 'audio');
      }
    `),
    { mode: 0o700 },
  );
  await writeFile(
    join(dir, 'ffmpeg'),
    script(`
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      const args = process.argv.slice(2);
      assert.equal(fs.readFileSync(args[args.indexOf('-i') + 1], 'utf8'), 'audio');
      assert.equal(args[args.indexOf('-c:a') + 1], 'libopus');
      fs.writeFileSync(args.at(-1), 'OggS test audio');
    `),
    { mode: 0o700 },
  );
  process.env.PATH = dir;
  const media = new Media(
    ConfigSchema.parse({ dataDir: dir, media: { voice: 'es-ES-ElviraNeural' } }),
  );
  const signal = new AbortController().signal;
  try {
    const voice = await media.voice('**Hola** [mundo](https://example.com) 👋', 'success', signal);
    assert.equal(voice.toString(), 'OggS test audio');
    const args = JSON.parse(await readFile(join(dir, 'args.json'), 'utf8'));
    assert.deepEqual(args, [
      '--voice',
      'es-ES-ElviraNeural',
      '--text',
      'Hola mundo',
      '--write-media',
      join(media.directory('success'), 'speech.mp3'),
    ]);
    await assert.rejects(
      media.voice('fail private text', 'failure', signal),
      /^Error: Speech synthesis failed$/,
    );
    assert.equal(JSON.parse(logs.at(-1)!).reason, 'exit_1');
    assert(!logs.join('').includes('private text'));
    await assert.rejects(media.voice('empty', 'empty', signal), /Speech synthesis failed/);
    await assert.rejects(
      media.voice('👋 ** https://example.com', 'symbols', signal),
      /readable text/,
    );

    const controller = new AbortController();
    const pending = assert.rejects(
      media.voice('wait', 'cancel', controller.signal),
      /Speech synthesis failed/,
    );
    let pid = 0;
    await until(async () => {
      pid = Number(await readFile(join(dir, 'pid'), 'utf8').catch(() => '0'));
      return pid > 0;
    });
    controller.abort();
    await pending;
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(JSON.parse(logs.at(-1)!).reason, 'aborted');
    await assert.rejects(media.voice('ignored', 'pre-aborted', controller.signal), /abort/i);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
