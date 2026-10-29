import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PairingRateLimit } from '../src/adapters/inbound/pairing-rate-limit.js';
import { once } from 'node:events';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import type { HomeAssistantPairing } from '../src/application/home-assistant-pairing.js';
import type { ConversationStore } from '../src/application/ports.js';

test('pairing admission preserves slots for other peers until the ten-minute window expires', () => {
  let now = 0;
  const limits = new PairingRateLimit(() => now);
  for (let i = 0; i < 5; i++) assert.equal(limits.retryAfter('192.0.2.1', 'begin'), 0);
  assert.equal(limits.retryAfter('::ffff:192.0.2.1', 'begin'), 600);
  assert.equal(limits.retryAfter('192.0.2.2', 'begin'), 0);
  now = 599_001;
  assert.equal(limits.retryAfter('192.0.2.1', 'begin'), 1);
  now = 600_000;
  assert.equal(limits.retryAfter('192.0.2.1', 'begin'), 0);
});

test('exchange failures have a separate quota and cannot block a legitimate begin', () => {
  let now = 0;
  const limits = new PairingRateLimit(() => now);
  for (let i = 0; i < 30; i++) assert.equal(limits.retryAfter('192.0.2.1', 'exchange'), 0);
  assert.equal(limits.retryAfter('192.0.2.1', 'exchange'), 60);
  assert.equal(limits.retryAfter('192.0.2.1', 'begin'), 0);
  now = 60_000;
  assert.equal(limits.retryAfter('192.0.2.1', 'exchange'), 0);
});

test('many-address floods cannot evict active quotas or grow the limiter without bound', () => {
  let now = 0;
  const limits = new PairingRateLimit(() => now);
  for (let i = 0; i < 5; i++) limits.retryAfter('192.0.2.1', 'begin');
  for (let i = 0; i < 1023; i++) assert.equal(limits.retryAfter('peer-' + i, 'begin'), 0);
  assert.equal(limits.retryAfter('new-peer', 'begin'), 60);
  assert.equal(limits.retryAfter('192.0.2.1', 'begin'), 600);
  now = 600_000;
  assert.equal(limits.retryAfter('new-peer', 'begin'), 0);
});

test('HTTP rejects a peer flood before parsing and ignores spoofed forwarding headers', async () => {
  const config = ConfigSchema.parse({ apiKey: 'test-key-that-is-long-enough' });
  let begins = 0;
  let exchanges = 0;
  const pairing = {
    begin: () => ({ id: String(++begins) }),
    exchange: async () => {
      exchanges++;
      throw new Error('Invalid pairing');
    },
  } as unknown as HomeAssistantPairing;
  const server = createHttpServer(
    config,
    {} as ConversationStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pairing,
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const input = {
    secret: 'a'.repeat(64),
    state: 'b'.repeat(64),
    homeAssistantUrl: 'https://ha.example',
    flowId: 'setup-flow',
    userId: 'c'.repeat(32),
  };
  const post = (path: string, body: string, peer = '192.0.2.1') =>
    fetch(base + '/v1/pairing/home-assistant' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': peer,
        'X-Real-IP': peer,
        Forwarded: 'for=' + peer,
      },
      body,
    });
  try {
    assert.equal((await post('', ' '.repeat(8193))).status, 400);
    assert.equal(begins, 0);
    for (let i = 0; i < 4; i++)
      assert.equal((await post('', JSON.stringify(input), '192.0.2.' + i)).status, 201);
    const blocked = await post('', '{invalid JSON', '198.51.100.1');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
    assert.equal(begins, 4);
    assert.equal((await post('/exchange', ' '.repeat(12_289))).status, 400);
    assert.equal(exchanges, 0);
    const exchange = JSON.stringify({
      id: '00000000-0000-4000-8000-000000000001',
      secret: input.secret,
      homeAssistantToken: 'home-assistant-private-token',
    });
    for (let i = 0; i < 29; i++) assert.equal((await post('/exchange', exchange)).status, 400);
    assert.equal((await post('/exchange', exchange, '198.51.100.2')).status, 429);
    assert.equal(exchanges, 29);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
