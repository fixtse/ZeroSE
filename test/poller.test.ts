import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramPoller } from '../src/adapters/inbound/telegram-poller.js';
import { fixture, until } from './helpers.js';
test('polling persists its cursor after durable enqueue and rejects unauthorized users', async () => {
  const f = await fixture();
  f.config.telegram.transport = 'polling';
  f.config.telegram.allowedUsers = ['1'];
  const offsets: number[] = [];
  const telegram = {
    async call(method: string, body: any, signal?: AbortSignal) {
      if (method === 'getWebhookInfo') return { url: '' };
      offsets.push(body.offset);
      if (offsets.length === 1)
        return [
          { update_id: 10, message: { from: { id: 1 }, chat: { id: 1 }, text: 'hello' } },
          { update_id: 10, message: { from: { id: 1 }, chat: { id: 1 }, text: 'duplicate' } },
          { update_id: 11, message: { from: { id: 2 }, chat: { id: 1 }, text: 'unauthorized' } },
        ];
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return [];
    },
  };
  const poller = new TelegramPoller(f.config.telegram, telegram, f.store);
  try {
    poller.start();
    await until(() => offsets.length >= 2);
    assert.deepEqual(offsets, [0, 12]);
    assert.equal(await f.store.cursor('telegram'), 12);
    assert.equal((await f.store.claim([]))?.payload.message.text, 'hello');
    assert.equal(await f.store.claim([]), undefined);
  } finally {
    await poller.close();
    await f.close();
  }
});
test('polling never replaces an existing webhook', async () => {
  const f = await fixture();
  f.config.telegram.transport = 'polling';
  const methods: string[] = [];
  const poller = new TelegramPoller(
    f.config.telegram,
    {
      async call(method) {
        methods.push(method);
        return { url: 'https://existing.example/webhook' };
      },
    },
    f.store,
  );
  try {
    poller.start();
    await until(() => methods.length > 0);
    await poller.close();
    assert.deepEqual(methods, ['getWebhookInfo']);
  } finally {
    await f.close();
  }
});

test('managed Helper polling discovers unapproved contacts without replying and uses an independent cursor', async () => {
  const { PostgresAccess } = await import('../src/adapters/outbound/postgres-access.js');
  const { Access } = await import('../src/application/access.js');
  const f = await fixture();
  f.config.telegram.transport = 'polling';
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  const access = new Access(repository, f.store);
  let calls = 0;
  const offsets: number[] = [];
  const telegram = {
    async call(method: string, body: any, signal?: AbortSignal) {
      if (method === 'getWebhookInfo') return { url: '' };
      assert.equal(method, 'getUpdates');
      offsets.push(body.offset);
      if (++calls === 1)
        return [
          {
            update_id: 10,
            message: {
              chat: { id: 99, type: 'private', first_name: 'Pending user' },
              from: { id: 99 },
              text: 'hello',
            },
          },
          {
            update_id: 11,
            message: {
              chat: { id: -99, type: 'group', title: 'Pending group' },
              from: { id: 99 },
              text: 'hello',
            },
          },
        ];
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return [];
    },
  };
  const poller = new TelegramPoller(
    f.config.telegram,
    telegram,
    f.store,
    (update) => access.receive('helper', update, '999'),
    'helper:999',
  );
  try {
    poller.start();
    await until(() => offsets.length >= 2);
    assert.deepEqual(offsets, [0, 12]);
    assert.equal(await f.store.cursor('helper:999'), 12);
    assert.equal(await f.store.cursor('telegram'), 0);
    assert.equal(await f.store.claim([]), undefined);
    const discovered = await repository.profiles('', 0, 20, true);
    assert.equal(discovered.total, 2);
    assert(discovered.items.every((p) => !p.enabled));
  } finally {
    await poller.close();
    await f.close();
  }
});
