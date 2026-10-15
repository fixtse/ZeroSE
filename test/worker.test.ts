import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assistant } from '../src/application/assistant.js';
import { fixture, until } from './helpers.js';
test('job worker runs different sessions concurrently and preserves order within a session', async () => {
  const f = await fixture(),
    started: string[] = [],
    completed: string[] = [];
  let releaseFirst!: () => void;
  const parallelCompleted = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const a = await f.store.enqueue('one', { kind: 'chat', text: 'first' });
  const b = await f.store.enqueue('one', { kind: 'chat', text: 'second' });
  const c = await f.store.enqueue('two', { kind: 'chat', text: 'parallel' });
  const worker = new Assistant(
    f.config,
    f.store,
    {
      chat: async (job) => {
        started.push(job.payload.text);
        if (job.payload.text === 'first') await parallelCompleted;
        completed.push(job.payload.text);
        if (job.payload.text === 'parallel') releaseFirst();
        return { output: job.payload.text };
      },
    },
    { async cleanup() {} },
    {
      async send() {},
      async sendVoice() {},
      async typing() {},
      async input() {
        throw new Error('unused');
      },
    },
  );
  try {
    worker.start();
    await until(async () =>
      (
        await Promise.all(
          [a, b, c].map(async (job) => (await f.store.job(job.id))?.status === 'done'),
        )
      ).every(Boolean),
    );
    assert.deepEqual(started, ['first', 'parallel', 'second']);
    assert(completed.indexOf('parallel') < completed.indexOf('first'));
  } finally {
    await worker.close();
    await f.close();
  }
});
test('delivery errors fail a job without replaying the completed action', async () => {
  const f = await fixture();
  let actions = 0,
    sends = 0;
  const job = await f.store.enqueue('telegram:1', {
    kind: 'telegram',
    message: { chat: { id: 1 } },
  });
  const worker = new Assistant(
    f.config,
    f.store,
    {
      telegram: async () => {
        actions++;
        return { output: 'completed action' };
      },
    },
    { async cleanup() {} },
    {
      async send() {
        sends++;
        throw new Error('Delivery unavailable');
      },
      async sendVoice() {},
      async typing() {},
      async input() {
        throw new Error('unused');
      },
    },
  );
  try {
    worker.start();
    await until(async () => (await f.store.job(job.id))?.status === 'failed');
    assert.equal(actions, 1);
    assert.equal(await f.store.claim([]), undefined);
    assert(sends >= 1);
  } finally {
    await worker.close();
    await f.close();
  }
});

test('a voice failure preserves text delivery and finishes without retrying the action', async () => {
  const f = await fixture();
  const sent: string[] = [];
  let actions = 0;
  let voices = 0;
  const job = await f.store.enqueue('telegram:1', {
    kind: 'telegram',
    message: { chat: { id: 1 } },
  });
  const worker = new Assistant(
    f.config,
    f.store,
    {
      telegram: async () => {
        actions++;
        return { output: 'Completed action' };
      },
    },
    { async cleanup() {} },
    {
      async send(_chat, text) {
        sent.push(text);
      },
      async sendVoice() {
        voices++;
        throw new Error('Speech synthesis failed');
      },
      async typing() {},
      async input() {
        throw new Error('unused');
      },
    },
  );
  try {
    worker.start();
    await until(async () => (await f.store.job(job.id))?.status === 'done');
    assert.equal(actions, 1);
    assert.equal(voices, 1);
    assert.deepEqual(sent, [
      'Completed action',
      'No se pudo generar la respuesta de voz; la respuesta de texto está arriba.',
    ]);
    assert.equal(await f.store.claim([]), undefined);
  } finally {
    await worker.close();
    await f.close();
  }
});
