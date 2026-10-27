import { localClock } from '../src/domain/time.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { chunks } from '../src/adapters/outbound/telegram.js';
import { fixture } from './helpers.js';
import { readFileSync } from 'node:fs';
test('HTTP ingress authenticates, restricts Telegram users and deduplicates deliveries', async () => {
  const f = await fixture();
  f.config.telegram.webhookSecret = 'secret';
  f.config.telegram.transport = 'webhook';
  f.config.telegram.allowedUsers = ['1'];
  const icon = readFileSync('assets/icon.png');
  const server = createHttpServer(f.config, f.store, icon);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const favicon = await fetch(base + '/favicon.ico');
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(Buffer.from(await favicon.arrayBuffer()), icon);
    assert.equal((await fetch(base + '/v1/chat', { method: 'POST' })).status, 401);
    const headers = {
      Authorization: `Bearer ${f.config.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'same',
    };
    const request = {
      method: 'POST',
      headers,
      body: JSON.stringify({ session: 'test', text: 'hello' }),
    };
    const first = (await (await fetch(base + '/v1/chat', request)).json()) as any;
    const second = (await (await fetch(base + '/v1/chat', request)).json()) as any;
    assert.equal(first.jobId, second.jobId);
    const update = {
      update_id: 1,
      message: { chat: { id: 123 }, from: { id: 2 }, text: 'denied' },
    };
    assert.equal(
      (
        await fetch(base + '/telegram/assistants/zero/webhook', {
          method: 'POST',
          headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
          body: JSON.stringify(update),
        })
      ).status,
      401,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
test('Home Assistant verifies shopping writes and rejects other domains and ambiguous names', async () => {
  let items = [
    { uid: 'one', summary: 'milk', status: 'needs_action' },
    { uid: 'two', summary: 'milk', status: 'needs_action' },
  ];
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-token');
    calls.push(req.url || '');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url?.includes('update_item'))
      items = items.map((item) =>
        item.uid === body.item ? { ...item, status: body.status } : item,
      );
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url?.includes('get_items')
          ? { service_response: { 'todo.shopping_list': { items } } }
          : [],
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const f = await fixture();
  f.config.homeAssistant.token = 'local-test-token';
  f.config.homeAssistant.shoppingListEntity = 'todo.shopping_list';
  f.config.homeAssistant.url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const ha = new HomeAssistant(f.config.homeAssistant);
    await assert.rejects(() => ha.changeShopping('complete', 'milk'), /unique item UID/);
    const after = await ha.changeShopping('complete', 'one');
    assert.equal(after[0].status, 'completed');
    await assert.rejects(() => ha.sensor('switch.light'), /not permitted/);
    await assert.rejects(
      () => ha.history('sensor.temperature', '2026-01-01', '2026-02-01'),
      /seven days/,
    );
    assert.equal(calls.filter((url) => url.includes('update_item')).length, 1);
    assert(calls.at(-1)?.includes('get_items'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
test('Telegram chunking preserves every code point within message limits', () => {
  const text = 'x'.repeat(4100) + ' 🛒 '.repeat(2000);
  const result = chunks(text);
  assert.equal(result.join(''), text);
  assert(result.every((chunk) => Array.from(chunk).length <= 3900));
});

test('morning webhook authenticates and deduplicates wake-ups and suppresses the later scheduled briefing', async () => {
  const f = await fixture();
  f.config.schedules.enabled = true;
  f.config.schedules.morning = '';
  f.config.telegram.notificationChatId = '123';
  const server = createHttpServer(f.config, f.store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/triggers/morning`;
  const request = { method: 'POST', headers: { Authorization: `Bearer ${f.config.apiKey}` } };
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const scheduled = await f.store.enqueue(
      'telegram:123',
      { kind: 'morning', chatId: '123' },
      'morning:' + localClock(new Date(), f.config.timezone).day,
    );
    const responses = await Promise.all([fetch(url, request), fetch(url, request)]);
    assert(responses.every((response) => response.status === 202));
    const [first, duplicate] = (await Promise.all(
      responses.map((response) => response.json()),
    )) as any[];
    assert.equal(first.jobId, duplicate.jobId);
    assert.notEqual(first.jobId, scheduled.id);
    assert.equal(
      await f.store.scheduled('morning:' + localClock(new Date(), f.config.timezone).day),
      true,
    );
    const job = await f.store.job(first.jobId);
    assert.equal(job?.session, 'telegram:123');
    assert.deepEqual(job?.payload, { kind: 'morning', chatId: '123', wakeUp: true });
    await f.store.fail(first.jobId, 'uncertain delivery');
    const failed = (await (await fetch(url, request)).json()) as any;
    assert.equal(failed.jobId, first.jobId);
    assert.equal(failed.status, 'failed');
    f.config.schedules.enabled = false;
    assert.equal((await fetch(url, request)).status, 503);
    f.config.schedules.enabled = true;
    f.config.telegram.notificationChatId = '';
    assert.equal((await fetch(url, request)).status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
