import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Access } from '../src/application/access.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { TelegramWebhook } from '../src/adapters/outbound/telegram-webhook.js';
import { TelegramBots } from '../src/adapters/inbound/telegram-bots.js';
import { Telegram } from '../src/adapters/outbound/telegram.js';
import { Media } from '../src/adapters/outbound/media.js';
import type { BotSettings } from '../src/domain/access.js';
import { fixture } from './helpers.js';

const url = 'https://example.com/telegram/salem/webhook';

test('Salem webhook authenticates independently, preserves polling dedupe and keeps new contacts pending', async () => {
  const f = await fixture();
  f.config.telegram.transport = 'webhook';
  f.config.telegram.webhookSecret = 'zero-secret';
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  const access = new Access(repository, f.store);
  const settings: BotSettings = {
    id: 'salem',
    token: '999:test-token',
    enabled: true,
    webhookUrl: url,
    webhookSecret: 'salem-secret',
  };
  await repository.saveBot(settings);
  const admin = new Admin(f.config, repository, async () => {});
  const server = createHttpServer(f.config, f.store, undefined, { access, admin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (update: unknown, secret = 'salem-secret', path = '/telegram/salem/webhook') =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(update),
    });
  const welcome = {
    update_id: 10,
    message: { chat: { id: -10, type: 'group', title: 'Pending group' }, group_chat_created: true },
  };
  try {
    assert.equal((await post(welcome, '')).status, 401);
    assert.equal((await post(welcome, 'zero-secret')).status, 401);
    assert.equal((await post(welcome, 'salem-secret', '/telegram/webhook')).status, 401);
    assert.equal((await post({ update_id: 'invalid' })).status, 400);
    const existing = await access.receive('salem', welcome, '999');
    const duplicate = (await (await post(welcome)).json()) as any;
    assert.equal(
      duplicate.jobId,
      existing!.id,
      'A pending Telegram redelivery must not replay a previously polled action',
    );
    const group = await repository.profile('salem', '-10');
    assert.equal(group?.enabled, false);
    assert.equal(group?.bot, 'salem');
    assert.equal(await repository.profile('zero', '-10'), undefined);
    const message = {
      update_id: 11,
      message: {
        chat: { id: 20, type: 'private', first_name: 'Pending user' },
        from: { id: 20 },
        text: 'hello',
      },
    };
    assert.equal(((await (await post(message)).json()) as any).jobId, undefined);
    assert.equal((await repository.profile('salem', '20'))?.enabled, false);
    await repository.saveProfile({ ...(await repository.profile('salem', '20'))!, enabled: true });
    const accepted = (await (await post({ ...message, update_id: 12 })).json()) as any;
    assert.equal((await f.store.job(accepted.jobId))?.session, 'salem:20');
    await repository.saveBot({ ...settings, enabled: false });
    assert.equal((await post({ ...message, update_id: 13 })).status, 200);
    assert.equal(
      (await f.store.pool.query("SELECT count(*) FROM jobs WHERE dedupe='salem:999:13'")).rows[0]
        .count,
      '0',
    );
    const stored = (await f.store.pool.query('SELECT webhook_secret FROM managed_bots')).rows[0]
      .webhook_secret;
    assert(!stored.includes('salem-secret'));
    assert.equal((await repository.bots())[0].webhookSecret, 'salem-secret');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('webhook registration preserves pending updates, uses the bot secret and never retries an uncertain mutation', async () => {
  const calls: { method: string; body: any }[] = [];
  let fail = false;
  const control = new TelegramWebhook(() => ({
    async call(method, body) {
      calls.push({ method, body });
      if (method === 'getWebhookInfo')
        return { url, pending_update_count: 2, last_error_message: 'temporary delivery failure' };
      if (fail) throw new Error('uncertain network failure');
      return true;
    },
  }));
  const settings: BotSettings = {
    id: 'salem',
    token: '999:test',
    enabled: true,
    webhookSecret: 'secret',
    webhookUrl: url,
  };
  await control.configure(settings);
  assert.deepEqual(calls, [
    {
      method: 'setWebhook',
      body: {
        url,
        secret_token: 'secret',
        allowed_updates: ['message'],
        drop_pending_updates: false,
      },
    },
  ]);
  fail = true;
  await assert.rejects(() => control.configure(settings), /uncertain/);
  assert.equal(calls.filter((c) => c.method === 'setWebhook').length, 2);
  assert.deepEqual(await control.status(settings), {
    url,
    pending: 2,
    lastError: 'temporary delivery failure',
  });
  assert(!calls.some((c) => ['getUpdates', 'deleteWebhook'].includes(c.method)));
});

test('admin explicitly registers Salem with an encrypted stable secret, checks status read-only and reports uncertain registration', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  let registrations = 0,
    reads = 0,
    fail = false;
  const admin = new Admin(f.config, repository, async () => {}, {
    async configure(settings) {
      registrations++;
      assert.equal(
        (await repository.bots())[0].webhookSecret,
        settings.webhookSecret,
        'Persist secret before Telegram starts delivering',
      );
      if (fail) throw new Error('uncertain');
    },
    async status(settings) {
      reads++;
      return { url: settings.webhookUrl || '', pending: 0 };
    },
  });
  const access = new Access(repository, f.store);
  const server = createHttpServer(f.config, f.store, undefined, { access, admin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1/admin/bots`;
  const headers = {
    Authorization: `Bearer ${f.config.apiKey}`,
    'Content-Type': 'application/json',
  };
  const put = (value: unknown) =>
    fetch(base + '/salem', { method: 'PUT', headers, body: JSON.stringify(value) });
  try {
    assert.equal((await put({ token: '999:test', enabled: true })).status, 400);
    for (const webhookUrl of [
      'http://example.com/telegram/salem/webhook',
      'https://example.com/telegram/webhook',
      url + '?secret=unsafe',
    ]) {
      assert.equal((await put({ token: '999:test', enabled: true, webhookUrl })).status, 400);
    }
    assert.equal(registrations, 0);
    assert.equal((await put({ token: '999:test', enabled: true, webhookUrl: url })).status, 200);
    const secret = (await repository.bots())[0].webhookSecret!;
    assert.match(secret, /^[A-Za-z0-9_-]{32,256}$/);
    assert.equal(registrations, 1);
    const status = (await (await fetch(base + '/salem/webhook', { headers })).json()) as any;
    assert.equal(status.registered, true);
    assert.equal(reads, 1);
    assert.equal(registrations, 1);
    const listing = JSON.stringify(await (await fetch(base, { headers })).json());
    assert(!listing.includes(secret));
    assert(!listing.includes('999:test'));
    assert(listing.includes('webhook'));
    assert.equal((await put({ enabled: false })).status, 200);
    assert.equal(registrations, 1, 'Disabling must not remove the webhook');
    fail = true;
    const failure = await put({ enabled: true });
    assert.equal(failure.status, 502);
    assert.equal(((await failure.json()) as any).saved, true);
    assert.equal(registrations, 2, 'Uncertain mutation must not be retried');
    assert.equal((await repository.bots())[0].webhookSecret, secret);
    await fetch(base + '/salem/webhook', { headers });
    assert.equal(registrations, 2, 'Checking must not replay registration');
    fail = false;
    assert.equal((await put({ token: '888:other-bot', enabled: true })).status, 200);
    assert.notEqual(
      (await repository.bots())[0].webhookSecret,
      secret,
      'Old bot callbacks must not authenticate as a replacement account',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('Salem starts no polling or settings synchronization when the process starts', async () => {
  const f = await fixture();
  f.config.telegram.transport = 'webhook';
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  await repository.saveBot({
    id: 'salem',
    token: '999:test',
    enabled: true,
    webhookUrl: url,
    webhookSecret: 'secret',
  });
  const access = new Access(repository, f.store);
  let reads = 0;
  const original = repository.bots.bind(repository);
  repository.bots = async () => {
    reads++;
    return original();
  };
  class NoPollingTelegram extends Telegram {
    async call(): Promise<any> {
      throw new Error('Must never poll');
    }
  }
  const media = new Media(f.config);
  const bots = new TelegramBots(
    f.config,
    media,
    new NoPollingTelegram(f.config, media),
    f.store,
    access,
  );
  try {
    bots.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reads, 0);
  } finally {
    await bots.close();
    await f.close();
  }
});
