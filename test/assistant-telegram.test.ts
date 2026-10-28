import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { fixture } from './helpers.js';
import { Access } from '../src/application/access.js';
import { AssistantDefinitions } from '../src/application/assistant-definitions.js';
import { AssistantTelegram } from '../src/application/assistant-telegram.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresAssistantDefinitions } from '../src/adapters/outbound/postgres-assistant-definitions.js';
import { PostgresZeroSettings } from '../src/adapters/outbound/postgres-zero-settings.js';
import { AssistantTelegramAdmin } from '../src/adapters/inbound/assistant-telegram-admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { sessionAddress, telegramSession, telegramWebhookPath } from '../src/domain/access.js';

async function setup() {
  const f = await fixture();
  f.config.telegram.token = '111:zero-fixture';
  f.config.telegram.transport = 'webhook';
  f.config.telegram.webhookSecret = 'zero-fixture-secret';
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  await new PostgresZeroSettings(f.store.db).initialize('Private Zero prompt');
  const definitions = new AssistantDefinitions(
    new PostgresAssistantDefinitions(f.store.db),
    randomUUID,
  );
  let validations = 0,
    registrations = 0,
    reads = 0,
    fail = false;
  let removals = 0;
  let removalHook: (() => Promise<void>) | undefined;
  const changed: string[] = [];
  const connections = new AssistantTelegram(
    repository,
    f.config.telegram,
    'https://zero.fixture',
    definitions,
    async (token) => {
      validations++;
      if (token === '999:bad') throw Error('Invalid Telegram credentials');
    },
    () => randomBytes(32).toString('hex'),
    {
      configure: async (value) => {
        registrations++;
        assert.equal((await repository.bot(value.id))?.webhookSecret, value.webhookSecret);
        if (fail) throw Error('Uncertain');
      },
      remove: async (value) => {
        removals++;
        assert.equal((await repository.bot(value.id))?.token, value.token);
        if (fail) throw Error('Uncertain removal');
        await removalHook?.();
      },
      status: async (value) => {
        reads++;
        return { url: value.webhookUrl || '', pending: 2 };
      },
    },
    async (id) => {
      changed.push(id);
    },
  );
  return {
    ...f,
    repository,
    definitions,
    connections,
    changed,
    removalCount: () => removals,
    onRemoval: (hook: () => Promise<void>) => {
      removalHook = hook;
    },
    counts: () => ({ validations, registrations, reads }),
    fail: () => {
      fail = true;
    },
  };
}

test('optional connections persist independently; Zero values are editable and concurrent bot reuse is rejected', async () => {
  const f = await setup();
  try {
    const a = await f.definitions.create({ name: 'Planner', prompt: 'Plan' }),
      b = await f.definitions.create({ name: 'Writer', prompt: 'Write' });
    assert.equal((await f.connections.read(a.id)).configured, false);
    assert.equal((await f.definitions.list('', 0, 50)).total, 3);
    const zero = await f.connections.read('zero');
    assert.equal(zero.accountId, '111');
    assert.equal(zero.webhookUrl, 'https://zero.fixture/telegram/assistants/zero/webhook');
    assert(!JSON.stringify(zero).includes('zero-fixture-secret'));
    assert(!JSON.stringify(zero).includes('111:zero-fixture'));
    const input = {
      token: '222:planner',
      enabled: true,
      transport: 'webhook' as const,
      webhookUrl: 'https://zero.fixture' + telegramWebhookPath(a.id),
      revision: 0,
      clearToken: false,
    };
    await f.connections.save(a.id, input);
    assert.equal(f.counts().registrations, 0);
    assert.equal((await f.repository.bot(a.id))?.token, '222:planner');
    await assert.rejects(
      f.connections.save(b.id, {
        ...input,
        webhookUrl: 'https://zero.fixture' + telegramWebhookPath(b.id),
      }),
      /otro asistente/,
    );
    await assert.rejects(f.connections.save(a.id, { ...input, token: '', revision: 0 }), /Recarga/);
    await f.connections.save('zero', {
      ...input,
      token: '',
      revision: zero.revision,
      webhookUrl: 'https://public.fixture' + telegramWebhookPath('zero'),
    });
    assert.equal((await f.repository.bot('zero'))?.token, '111:zero-fixture');
    assert.equal(f.counts().validations, 1);
    const updated = await f.connections.read('zero');
    await f.connections.save('zero', {
      ...input,
      token: '333:new-zero',
      revision: updated.revision,
      webhookUrl: 'https://new.fixture' + telegramWebhookPath('zero'),
    });
    await f.repository.initialize({
      ...f.config,
      telegram: { ...f.config.telegram, token: '888:server-change' },
    });
    assert.equal((await f.repository.bot('zero'))?.token, '333:new-zero');
    const c = await f.definitions.create({ name: 'Third', prompt: 'Third' });
    const attempts = await Promise.allSettled(
      [b, c].map((value) =>
        f.connections.save(value.id, {
          ...input,
          token: '444:shared',
          webhookUrl: 'https://zero.fixture' + telegramWebhookPath(value.id),
        }),
      ),
    );
    assert.equal(attempts.filter((value) => value.status === 'fulfilled').length, 1);
    const ciphertext = (await f.store.pool.query('SELECT token,webhook_secret FROM managed_bots'))
      .rows;
    assert(!JSON.stringify(ciphertext).includes('planner'));
    assert(!JSON.stringify(ciphertext).includes('new-zero'));
    assert.equal(await f.definitions.remove(a.id, a.revision), 'conflict');
    const saved = await f.connections.read(a.id);
    await f.connections.save(a.id, {
      ...input,
      token: '',
      enabled: false,
      clearToken: true,
      revision: saved.revision,
    });
    assert.equal(await f.definitions.remove(a.id, a.revision), 'deleted');
  } finally {
    await f.close();
  }
});

test('webhook registration requires explicit confirmation, stable revision and never replays an uncertain mutation', async () => {
  const f = await setup();
  try {
    const assistant = await f.definitions.create({
      name: 'Webhook fixture',
      prompt: 'Test prompt',
    });
    const handler = new AssistantTelegramAdmin(f.connections);
    async function call(method: string, body: unknown, action = '') {
      let response: any;
      await handler.handle(
        { method } as IncomingMessage,
        '/v1/admin/setup/assistants/' + assistant.id + '/telegram' + action,
        async () => body,
        (status, value) => {
          response = { status, value };
        },
      );
      return response;
    }
    const input = {
      token: '555:helper',
      enabled: true,
      transport: 'webhook',
      webhookUrl: 'https://zero.fixture' + telegramWebhookPath(assistant.id),
      revision: 0,
    };
    assert.equal((await call('PUT', input)).status, 200);
    assert.equal(f.counts().registrations, 0);
    assert.equal((await call('POST', { confirm: false, revision: 1 }, '/register')).status, 400);
    assert.equal((await call('POST', { confirm: true, revision: 0 }, '/register')).status, 409);
    assert.equal((await call('POST', { confirm: true, revision: 1 }, '/register')).status, 200);
    assert.equal(f.counts().registrations, 1);
    f.fail();
    assert.equal((await call('POST', { confirm: true, revision: 1 }, '/register')).status, 502);
    assert.equal(f.counts().registrations, 2);
    assert.equal((await call('GET', undefined, '/status')).value.pending, 2);
    assert.equal(f.counts().registrations, 2);
    assert.equal(f.counts().reads, 1);
  } finally {
    await f.close();
  }
});

test('canonical webhook routes isolate assistants, keep new contacts pending and retire old ingress', async () => {
  const f = await setup();
  const a = await f.definitions.create({ name: 'Planner', prompt: 'Plan' }),
    b = await f.definitions.create({ name: 'Writer', prompt: 'Write' });
  const access = new Access(f.repository, f.store);
  const admin = new Admin(f.config, f.repository, async () => {});
  const server = createHttpServer(f.config, f.store, undefined, { access, admin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const message = {
    update_id: 1,
    message: {
      chat: { id: 20, type: 'private', first_name: 'User' },
      from: { id: 20 },
      text: 'Hello',
    },
  };
  async function post(id: string, secret: string) {
    return fetch(base + telegramWebhookPath(id), {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(message),
    });
  }
  try {
    for (const [index, value] of [a, b].entries())
      await f.connections.save(value.id, {
        token: 600 + index + ':fixture',
        enabled: true,
        transport: 'webhook',
        webhookUrl: 'https://zero.fixture' + telegramWebhookPath(value.id),
        revision: 0,
        clearToken: false,
      });
    const aSecret = (await f.repository.bot(a.id))!.webhookSecret!,
      bSecret = (await f.repository.bot(b.id))!.webhookSecret!;
    assert.equal((await post(a.id, bSecret)).status, 401);
    assert.equal(((await (await post(a.id, aSecret)).json()) as any).jobId, undefined);
    assert.equal((await f.repository.profile(a.id, '20'))?.enabled, false);
    for (const value of [a, b]) {
      await access.receive(value.id, message);
      const profile = await f.repository.profile(value.id, '20');
      await f.repository.saveProfile({ ...profile!, enabled: true });
    }
    const first = (await (await post(a.id, aSecret)).json()) as any,
      second = (await (await post(b.id, bSecret)).json()) as any;
    assert.notEqual(first.jobId, second.jobId);
    assert.equal((await f.store.job(first.jobId))?.session, telegramSession(a.id, '20'));
    assert.deepEqual(sessionAddress(telegramSession(a.id, '20')), { bot: a.id, chatId: '20' });
    assert.equal(
      (await f.definitions.resolve(await f.repository.profile(a.id, '20'), a.id)).id,
      a.id,
    );
    await f.repository.saveProfile({
      bot: 'zero',
      chatId: '20',
      kind: 'user',
      label: 'Zero user',
      enabled: true,
      owner: false,
      capabilities: ['web'],
    });
    const zero = (await (await post('zero', 'zero-fixture-secret')).json()) as any;
    assert.equal((await f.store.job(zero.jobId))?.session, 'telegram:20');
    assert.equal((await f.store.job(zero.jobId))?.payload.accountId, '111');
    for (const path of ['/telegram/webhook', '/telegram/helper/webhook'])
      assert.equal(
        (
          await fetch(base + path, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + f.config.apiKey },
            body: '{}',
          })
        ).status,
        404,
      );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('connection migration rewrites stored routes without changing secrets or restoring server overrides', async () => {
  const f = await setup();
  try {
    await f.repository.saveBot({
      id: 'helper',
      enabled: true,
      token: '777:helper',
      webhookUrl: 'https://old.fixture/telegram/helper/webhook',
      webhookSecret: 'saved-secret',
    });
    await f.repository.initialize(f.config);
    assert.equal(
      (await f.repository.bot('helper'))?.webhookUrl,
      'https://old.fixture/telegram/assistants/helper/webhook',
    );
    assert.equal((await f.repository.bot('helper'))?.webhookSecret, 'saved-secret');
    assert.deepEqual(f.counts(), { validations: 0, registrations: 0, reads: 0 });
  } finally {
    await f.close();
  }
});

test('removing Telegram clears credentials and disables polling only after confirmed webhook removal', async () => {
  const f = await setup();
  try {
    const a = await f.definitions.create({ name: 'Planner', prompt: 'Plan' });
    await f.connections.save(a.id, {
      token: '222:planner',
      enabled: true,
      transport: 'polling',
      webhookUrl: '',
      revision: 0,
      clearToken: false,
    });
    const before = await f.connections.read(a.id);
    await assert.rejects(f.connections.remove(a.id, 0), /Recarga/);
    assert.equal(f.removalCount(), 0);
    await f.connections.remove(a.id, before.revision);
    const saved = await f.repository.bot(a.id);
    assert.equal(saved?.token, '');
    assert.equal(saved?.webhookSecret, undefined);
    assert.equal(saved?.enabled, false);
    assert.equal(saved?.transport, 'disabled');
    assert.equal((await f.connections.read(a.id)).configured, false);
    assert.equal(f.removalCount(), 1);
    assert.equal(f.changed.at(-1), a.id);
    assert(await f.definitions.get(a.id));
  } finally {
    await f.close();
  }
});

test('uncertain webhook removal retains the saved token and is never retried automatically', async () => {
  const f = await setup();
  try {
    const a = await f.definitions.create({ name: 'Planner', prompt: 'Plan' });
    await f.connections.save(a.id, {
      token: '222:planner',
      enabled: true,
      transport: 'webhook',
      webhookUrl: 'https://zero.fixture' + telegramWebhookPath(a.id),
      revision: 0,
      clearToken: false,
    });
    const before = await f.repository.bot(a.id);
    const changes = f.changed.length;
    f.fail();
    await assert.rejects(f.connections.remove(a.id, before!.revision!), /Uncertain/);
    assert.deepEqual(await f.repository.bot(a.id), before);
    assert.equal(f.removalCount(), 1);
    assert.equal(f.changed.length, changes);
  } finally {
    await f.close();
  }
});

test('confirmed webhook removal preserves a concurrently replaced Telegram credential', async () => {
  const f = await setup();
  try {
    const a = await f.definitions.create({ name: 'Planner', prompt: 'Plan' });
    const input = {
      token: '222:planner',
      enabled: true,
      transport: 'polling' as const,
      webhookUrl: '',
      revision: 0,
      clearToken: false,
    };
    await f.connections.save(a.id, input);
    const before = await f.connections.read(a.id);
    f.onRemoval(async () => {
      await f.connections.save(a.id, {
        ...input,
        token: '333:replacement',
        revision: before.revision,
      });
    });
    await assert.rejects(f.connections.remove(a.id, before.revision), /conexión cambió/);
    assert.equal((await f.repository.bot(a.id))?.token, '333:replacement');
    assert.equal((await f.repository.bot(a.id))?.enabled, true);
    assert.equal(f.removalCount(), 1);
  } finally {
    await f.close();
  }
});
