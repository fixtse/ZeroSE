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

const url = 'https://example.com/telegram/assistants/helper/webhook';

test('Helper webhook authenticates independently, preserves polling dedupe and keeps new contacts pending', async () => {
  const f = await fixture();
  f.config.telegram.transport = 'webhook';
  f.config.telegram.webhookSecret = 'zero-secret';
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  const access = new Access(repository, f.store);
  const settings: BotSettings = {
    id: 'helper',
    token: '999:test-token',
    enabled: true,
    webhookUrl: url,
    webhookSecret: 'helper-secret',
  };
  await repository.saveBot(settings);
  const admin = new Admin(f.config, repository, async () => {});
  const server = createHttpServer(f.config, f.store, undefined, { access, admin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (
    update: unknown,
    secret = 'helper-secret',
    path = '/telegram/assistants/helper/webhook',
  ) =>
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
    const probe = (secret: string) => fetch(base + '/telegram/assistants/helper/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': secret,
        'X-Zero-Webhook-Probe': 'e7b87ca1-c63f-44ad-86eb-d5b9e3d7b607',
      },
    });
    assert.equal((await probe('zero-secret')).status, 401);
    assert.deepEqual(await (await probe('helper-secret')).json(), {
      webhookProbe: 'e7b87ca1-c63f-44ad-86eb-d5b9e3d7b607',
      assistantId: 'helper',
      enabled: true,
    });
    assert.equal((await f.store.pool.query('SELECT count(*) FROM jobs')).rows[0].count, '0');
    assert.equal(await repository.profile('helper', '20'), undefined);
    assert.equal((await post(welcome, '')).status, 401);
    assert.equal((await post(welcome, 'zero-secret')).status, 401);
    assert.equal((await post(welcome, 'helper-secret', '/telegram/webhook')).status, 401);
    assert.equal((await post({ update_id: 'invalid' })).status, 400);
    const existing = await access.receive('helper', welcome, '999');
    const duplicate = (await (await post(welcome)).json()) as any;
    assert.equal(
      duplicate.jobId,
      existing!.id,
      'A pending Telegram redelivery must not replay a previously polled action',
    );
    const group = await repository.profile('helper', '-10');
    assert.equal(group?.enabled, false);
    assert.equal(group?.bot, 'helper');
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
    assert.equal((await repository.profile('helper', '20'))?.enabled, false);
    await repository.saveProfile({ ...(await repository.profile('helper', '20'))!, enabled: true });
    const accepted = (await (await post({ ...message, update_id: 12 })).json()) as any;
    assert.equal((await f.store.job(accepted.jobId))?.session, 'helper:20');
    await repository.saveBot({ ...settings, enabled: false });
    assert.equal(((await (await probe('helper-secret')).json()) as any).enabled, false);
    assert.equal((await post({ ...message, update_id: 13 })).status, 200);
    assert.equal(
      (await f.store.pool.query("SELECT count(*) FROM jobs WHERE dedupe='helper:999:13'")).rows[0]
        .count,
      '0',
    );
    const stored = (
      await f.store.pool.query("SELECT webhook_secret FROM managed_bots WHERE id='helper'")
    ).rows[0].webhook_secret;
    assert(!stored.includes('helper-secret'));
    assert.equal((await repository.bots())[0].webhookSecret, 'helper-secret');
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
    id: 'helper',
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
    lastErrorAt: undefined,
  });
  assert(!calls.some((c) => ['getUpdates', 'deleteWebhook'].includes(c.method)));
});

test('webhook status probes only the saved registered endpoint and rejects failed or unrelated responses', async () => {
  const settings: BotSettings = {
    id: 'helper', token: '999:test', enabled: true, transport: 'webhook',
    webhookSecret: 'secret', webhookUrl: url,
  };
  let registeredUrl = url;
  let mode = 'ok';
  let probes = 0;
  const control = new TelegramWebhook(() => ({
    async call(method) {
      assert.equal(method, 'getWebhookInfo');
      return { url: registeredUrl, pending_update_count: 0,
        last_error_message: 'old 502', last_error_date: 123 };
    },
  }), async (input, init) => {
    probes++;
    assert.equal(String(input), url);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-Telegram-Bot-Api-Secret-Token'), 'secret');
    if (mode === 'network') throw new Error('private connection detail');
    if (mode === '502') return new Response('', { status: 502 });
    return Response.json({ webhookProbe: mode === 'wrong' ? 'stale' : headers.get('X-Zero-Webhook-Probe'),
      assistantId: 'helper', enabled: mode !== 'disabled' });
  });
  const healthy = await control.status(settings);
  assert.equal(healthy.reachable, true);
  assert.equal(healthy.lastError, 'old 502');
  assert.equal(healthy.lastErrorAt, 123);
  for (mode of ['502', 'wrong', 'disabled', 'network']) {
    const failed = await control.status(settings);
    assert.equal(failed.reachable, false);
    assert.ok(failed.probeError);
    assert.ok(!failed.probeError.includes('private'));
  }
  const before = probes;
  registeredUrl = 'https://other.example/webhook';
  assert.equal((await control.status(settings)).reachable, undefined);
  registeredUrl = url;
  await control.status({ ...settings, enabled: false });
  await control.status({ ...settings, transport: 'polling' });
  await control.status({ ...settings, webhookUrl: 'http://example.com/telegram/assistants/helper/webhook' });
  assert.equal(probes, before);
});

test('Helper starts no polling or settings synchronization when the process starts', async () => {
  const f = await fixture();
  f.config.telegram.transport = 'webhook';
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  await repository.saveBot({
    id: 'helper',
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
    await bots.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reads, 1);
  } finally {
    await bots.close();
    await f.close();
  }
});

test('explicit webhook removal keeps pending updates and never retries an uncertain delete', async () => {
  const calls: { method: string; body: unknown }[] = [];
  const webhook = new TelegramWebhook(() => ({
    call: async (method, body) => {
      calls.push({ method, body });
      throw Error('Uncertain deletion');
    },
  }));
  await assert.rejects(webhook.remove({ id: 'zero', enabled: true, token: '111:fixture' }));
  assert.deepEqual(calls, [{ method: 'deleteWebhook', body: { drop_pending_updates: false } }]);
});
