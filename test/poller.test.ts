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
