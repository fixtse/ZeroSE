import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Access } from '../src/application/access.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
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
      async sendImage() {},
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
      async sendImage() {},
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
      async sendImage() {},
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

test('pending chats stay silent, welcome is the only exception, and delivery uses the selected bot', async () => {
  const f = await fixture();
  const events: string[] = [];
  const pending = await f.store.enqueue('salem:1', {
    kind: 'telegram',
    message: { chat: { id: 1, type: 'private' } },
  });
  const welcome = await f.store.enqueue('salem:-2', {
    kind: 'telegram',
    message: { chat: { id: -2, type: 'group' }, group_chat_created: true },
  });
  const failure = await f.store.enqueue('salem:3', {
    kind: 'telegram',
    message: { chat: { id: 3, type: 'private' } },
  });
  const telegram = {
    async input() {
      throw new Error('unused');
    },
    async send(chat: string, text: string) {
      events.push(`${chat}:${text}`);
    },
    async sendImage() {},
    async sendVoice() {
      throw new Error('No voice expected');
    },
    async typing() {
      events.push('typing');
    },
  };
  const worker = new Assistant(
    f.config,
    f.store,
    {
      telegram: async (job) => {
        if (job.id === failure.id) throw new Error('Error must not be sent to pending chat');
        return {
          output: job.id === welcome.id ? '¡Hola! Soy Salem. Chat ID: -2' : 'Must not be delivered',
          voice: false,
        };
      },
    },
    { async cleanup() {} },
    {
      ...telegram,
      async send() {
        throw new Error('Must not use Zero for Salem');
      },
    },
    async () => telegram,
    async () => false,
  );
  try {
    worker.start();
    await until(
      async () =>
        (await f.store.job(pending.id))?.status === 'done' &&
        (await f.store.job(welcome.id))?.status === 'done' &&
        (await f.store.job(failure.id))?.status === 'failed',
    );
    assert.deepEqual(events, ['-2:¡Hola! Soy Salem. Chat ID: -2']);
  } finally {
    await worker.close();
    await f.close();
  }
});

test('generated images use the selected bot, handle image-only replies and never replay failed uploads', async () => {
  const f = await fixture();
  const events: string[] = [];
  let generations = 0;
  const jobs = await Promise.all(
    ['telegram:1', 'salem:2', 'salem:3', 'salem:4'].map((session, index) =>
      f.store.enqueue(session, {
        kind: 'telegram',
        message: { message_id: 7, chat: { id: index + 1 } },
      }),
    ),
  );
  const worker = new Assistant(
    f.config,
    f.store,
    {
      telegram: async (job, context) => {
        generations++;
        context.generatedImages = [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }];
        return { output: '', deliver: job.session === 'salem:4' ? false : true };
      },
    },
    { async cleanup() {} },
    {
      async input() {
        throw new Error('unused');
      },
      async typing() {},
      async send() {
        throw new Error('Wrong bot');
      },
      async sendVoice() {
        throw new Error('Wrong bot');
      },
      async sendImage() {
        throw new Error('Wrong bot');
      },
    },
    async (job) => ({
      async input() {
        throw new Error('unused');
      },
      async typing() {},
      async send(_chat, text) {
        if (text) events.push(`text:${text}`);
      },
      async sendVoice() {
        throw new Error('Image-only replies must not synthesize speech');
      },
      async sendImage(chat, image, signal, replyTo) {
        events.push(`${job.session}:${chat}`);
        assert.equal(image.mimeType, 'image/png');
        assert.equal(replyTo, 7);
        assert(!signal.aborted);
        if (chat === '3') throw new Error('Upload uncertain');
      },
    }),
  );
  try {
    worker.start();
    await until(async () =>
      (await Promise.all(jobs.map((job) => f.store.job(job.id)))).every((job) =>
        ['done', 'failed'].includes(job?.status || ''),
      ),
    );
    assert.equal(generations, 4);
    assert(events.includes('telegram:1:1'));
    assert(events.includes('salem:2:2'));
    assert.equal(events.filter((e) => e === 'salem:3:3').length, 1);
    assert(!events.includes('salem:4:4'));
    assert.equal((await f.store.job(jobs[2].id))?.status, 'failed');
    assert.equal((await f.store.job(jobs[0].id))?.status, 'done');
    assert(!events.some((e) => e.includes('respuesta de voz')));
    assert.equal(await f.store.claim([]), undefined);
  } finally {
    await worker.close();
    await f.close();
  }
});

test('per-chat voice preferences are checked at delivery and text replies remain available', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  const access = new Access(repository, f.store);
  for (const chatId of ['1', '2'])
    await repository.saveProfile({
      bot: 'salem',
      chatId,
      kind: 'user',
      label: chatId,
      owner: false,
      enabled: true,
      capabilities: ['transcription'],
      voiceReplies: true,
    });
  const sent: string[] = [],
    voices: string[] = [];
  let disableDuringRequest = true;
  const handler = async (job: import('../src/domain/models.js').Job) => {
    if (job.session === 'salem:1' && disableDuringRequest) {
      const profile = (await repository.profile('salem', '1'))!;
      await repository.saveProfile({ ...profile, voiceReplies: false });
    }
    return { output: 'Text reply' };
  };
  const worker = new Assistant(
    f.config,
    f.store,
    { telegram: handler, morning: handler },
    { async cleanup() {} },
    {
      async send(chat) {
        sent.push(chat);
      },
      async sendVoice(chat) {
        voices.push(chat);
      },
      async sendImage() {},
      async typing() {},
      async input() {
        throw new Error('unused');
      },
    },
    undefined,
    async () => true,
    async (job) => (await access.forSession(job.session))?.voiceReplies !== false,
  );
  const enqueue = (chatId: string, kind: 'telegram' | 'morning' = 'telegram') =>
    f.store.enqueue('salem:' + chatId, { kind, chatId, message: { chat: { id: Number(chatId) } } });
  const done = (id: string) => until(async () => (await f.store.job(id))?.status === 'done');
  try {
    const first = await enqueue('1');
    const other = await enqueue('2', 'morning');
    worker.start();
    await Promise.all([done(first.id), done(other.id)]);
    assert.deepEqual(sent.sort(), ['1', '2']);
    assert.deepEqual(voices, ['2']);
    disableDuringRequest = false;
    await repository.saveProfile({
      ...(await repository.profile('salem', '1'))!,
      voiceReplies: true,
    });
    await done((await enqueue('1')).id);
    assert.deepEqual(voices, ['2', '1']);
    f.config.telegram.voiceReplies = false;
    await done((await enqueue('1')).id);
    assert.equal(voices.length, 2, 'A chat cannot override the global voice switch');
    assert.equal(sent.length, 4);
  } finally {
    await worker.close();
    await f.close();
  }
});

test('delivery rechecks capabilities required by calendar-enriched weather but permits general weather', async () => {
  const f = await fixture();
  let calendarEnabled = true;
  const sent: string[] = [];
  const contextual = await f.store.enqueue('telegram:1', {
    kind: 'contextual_weather',
    chatId: '1',
  });
  const general = await f.store.enqueue('telegram:1', { kind: 'general_weather', chatId: '1' });
  const worker = new Assistant(
    f.config,
    f.store,
    {
      contextual_weather: async () => {
        calendarEnabled = false;
        return {
          output: 'Private event details',
          requiredCapabilities: ['calendar'],
          voice: false,
        };
      },
      general_weather: async () => ({ output: 'Rain now expected at 17:00', voice: false }),
    },
    { cleanup: async () => {} },
    {
      send: async (_chat, text) => {
        sent.push(text);
      },
      sendImage: async () => {},
      sendVoice: async () => {},
      typing: async () => {},
      input: async () => {
        throw new Error('unused');
      },
    },
    undefined,
    async (_job, result) => !result?.requiredCapabilities?.includes('calendar') || calendarEnabled,
  );
  try {
    worker.start();
    await until(
      async () =>
        (await f.store.job(contextual.id))?.status === 'done' &&
        (await f.store.job(general.id))?.status === 'done',
    );
    assert.deepEqual(sent, ['Rain now expected at 17:00']);
  } finally {
    await worker.close();
    await f.close();
  }
});
