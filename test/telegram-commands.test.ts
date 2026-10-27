import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { TelegramCommands } from '../src/adapters/outbound/telegram-commands.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { Access } from '../src/application/access.js';
import type { AccessProfile } from '../src/domain/access.js';
import { fixture } from './helpers.js';

const profile = (chatId: string): AccessProfile => ({
  bot: 'helper',
  chatId,
  kind: chatId.startsWith('-') ? 'group' : 'user',
  label: 'Test chat',
  enabled: true,
  owner: false,
  capabilities: ['web', 'transcription'],
});

test('Telegram commands are scoped to each bot and chat, filtered by permissions, and cleared when disabled', async () => {
  const calls: { bot: string; method: string; body: any }[] = [];
  let failure = false;
  let confirmed = true;
  const commands = new TelegramCommands(async (bot) => ({
    async call(method, body, signal) {
      assert(signal);
      calls.push({ bot, method, body });
      if (failure) throw new Error('Uncertain remote failure');
      return confirmed;
    },
  }));
  for (const bot of ['helper', 'zero'] as const) {
    for (const chatId of ['10', '-10020']) {
      const p = { ...profile(chatId), bot };
      await commands.configure(p);
      assert.deepEqual(calls.at(-1), {
        bot,
        method: 'setMyCommands',
        body: {
          scope: { type: 'chat', chat_id: chatId },
          language_code: '',
          commands: [
            {
              command: 'nuevo',
              description: 'Iniciar una conversación nueva sin borrar recuerdos',
            },
          ],
        },
      });
      await commands.configure({ ...p, capabilities: ['tasks'] });
      assert.deepEqual(
        calls.at(-1)!.body.commands.map((c: any) => c.command),
        ['nuevo', 'clean'],
      );
      await commands.configure({ ...p, enabled: false });
      assert.deepEqual(calls.at(-1)!.body.commands, []);
    }
  }
  failure = true;
  const before: number = calls.length;
  await assert.rejects(commands.configure(profile('10')), /Uncertain remote failure/);
  assert.equal(calls.length, before + 1, 'Uncertain mutations must not be retried');
  failure = false;
  confirmed = false;
  await assert.rejects(commands.configure(profile('10')), /did not confirm/);
});

test('web approval saves access before publishing commands, updates menus on edits, and reports partial failures', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  const calls: AccessProfile[] = [];
  let failure = false;
  const admin = new Admin(f.config, repository, async () => {}, undefined, {
    async configure(p) {
      assert.equal((await repository.profile(p.bot, p.chatId))?.enabled, p.enabled);
      calls.push(p);
      if (failure) throw new Error('Uncertain Telegram failure');
    },
  });
  const server = createHttpServer(f.config, f.store, undefined, {
    access: new Access(repository, f.store),
    admin,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1/admin/profiles`;
  const put = (p: AccessProfile, authorized = true) =>
    fetch(`${base}/${p.bot}/${p.chatId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { Authorization: `Bearer ${f.config.apiKey}` } : {}),
      },
      body: JSON.stringify(p),
    });
  try {
    assert.equal((await put(profile('10'), false)).status, 401);
    assert.equal(calls.length, 0);
    for (const chatId of ['10', '-10020']) {
      const p = profile(chatId);
      assert.equal((await put({ ...p, enabled: false })).status, 200);
      const before: number = calls.length;
      assert.equal((await put(p)).status, 200);
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1)?.chatId, chatId);
      assert.equal((await put({ ...p, capabilities: ['tasks'] })).status, 200);
      assert.deepEqual(calls.at(-1)?.capabilities, ['tasks']);
      assert.equal((await put({ ...p, enabled: false })).status, 200);
      assert.equal(calls.at(-1)?.enabled, false);
    }
    failure = true;
    const before: number = calls.length;
    const response = await put(profile('10'));
    assert.equal(response.status, 502);
    const body = (await response.json()) as any;
    assert.equal(body.saved, true);
    assert.match(body.error, /menú de comandos/);
    assert.equal((await repository.profile('helper', '10'))?.enabled, true);
    assert.equal(calls.length, before + 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
