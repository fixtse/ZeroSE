import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Access, scopedConfig } from '../src/application/access.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { Memory } from '../src/application/memory.js';
import { Tools } from '../src/application/tool-registry.js';
import {
  registerGoogleTools,
  registerHomeAssistantTools,
  registerMemoryTools,
} from '../src/adapters/inbound/integration-tools.js';
import { Google } from '../src/adapters/outbound/google.js';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { capabilities, toolCapability, type AccessProfile } from '../src/domain/access.js';
import { fixture } from './helpers.js';

const disabledEmbeddings = {
  enabled: false,
  async embed() {
    return [];
  },
};
const profile = (chatId: string, kind: 'group' | 'user' = 'user'): AccessProfile => ({
  bot: 'salem',
  chatId,
  kind,
  label: chatId,
  enabled: false,
  capabilities: ['web', 'transcription'],
  owner: false,
});

test('discovery records Salem contacts as pending, never inherits sender permission, and isolates bot dedupe keys', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  const access = new Access(repository, f.store);
  const update = (id: number, chatId: number, type = 'private') => ({
    update_id: id,
    message: {
      message_id: id,
      chat: { id: chatId, type, title: 'A group', first_name: 'User' },
      from: { id: Math.abs(chatId) },
      text: 'hello',
    },
  });
  try {
    assert.equal(await access.receive('salem', update(1, 10)), undefined);
    let pending = await repository.profile('salem', '10');
    assert.equal(pending?.enabled, false);
    assert.deepEqual(pending?.capabilities, ['web', 'transcription']);
    assert.equal(await f.store.claim([]), undefined);
    await repository.saveProfile({ ...pending!, enabled: true });
    const accepted = await access.receive('salem', update(2, 10));
    assert.equal(accepted?.session, 'salem:10');
    const duplicate = await access.receive('salem', update(2, 10));
    assert.equal(duplicate?.id, accepted?.id);
    const otherBot = await access.receive('zero', update(2, 10));
    assert.equal(otherBot, undefined, 'Salem permission must not authorize Zero');
    const group = update(3, -10, 'group');
    group.message.from.id = 10;
    assert.equal(
      await access.receive('salem', group),
      undefined,
      'Allowed user must not authorize their group',
    );
    assert.equal((await repository.profile('salem', '-10'))?.enabled, false);
    const join = {
      ...group,
      update_id: 4,
      message: { ...group.message, text: undefined, group_chat_created: true },
    };
    assert.equal(
      (await access.receive('salem', join))?.session,
      'salem:-10',
      'Only membership events bypass access',
    );
    assert.equal(
      (await repository.profile('salem', '-10'))?.enabled,
      false,
      'Welcome must not activate the group',
    );
    await repository.saveProfile({ ...profile('-10', 'group'), enabled: true });
    assert.ok(await access.receive('salem', { ...group, update_id: 5 }));
    await repository.saveProfile({ ...profile('-10', 'group'), enabled: false });
    assert.equal(await access.receive('salem', { ...group, update_id: 6 }), undefined);
    assert.equal((await repository.profiles('', 0, 20, true)).total, 2);
    assert.equal((await repository.profiles('A group', 0, 1, true)).items.length, 1);
    assert.equal((await repository.profiles('', 99, 20, true)).total, 2);
    await assert.rejects(() => access.receive('salem', { update_id: 'wrong' }), /Invalid update/);
  } finally {
    await f.close();
  }
});

test('only the original owner inherits legacy credentials and memory; each new chat has separate memory', async () => {
  const f = await fixture();
  f.config.telegram.allowedUsers = ['1', '2'];
  f.config.memory.sharedProfile = 'legacy-owner';
  f.config.google.refreshToken = 'private-owner-google';
  f.config.homeAssistant.token = 'private-owner-ha';
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  try {
    const owner = (await repository.profile('zero', '1'))!;
    assert.equal(owner.owner, true);
    const original = scopedConfig(f.config, owner);
    assert.equal(original.google.refreshToken, 'private-owner-google');
    assert.equal(original.memory.sharedProfile, 'legacy-owner');
    await repository.saveProfile({ ...owner, enabled: false });
    await repository.initialize(f.config);
    assert.equal(
      (await repository.profile('zero', '1'))?.enabled,
      false,
      'Restart must not reactivate a disabled owner',
    );
    const second = (await repository.profile('zero', '2'))!;
    assert.equal(second.owner, false);
    assert.deepEqual(second.capabilities, ['web', 'transcription']);
    const a = scopedConfig(f.config, { ...profile('10'), enabled: true });
    const b = scopedConfig(f.config, {
      ...profile('-20', 'group'),
      enabled: true,
      capabilities: [...capabilities],
    });
    assert.equal(a.google.refreshToken, '');
    assert.equal(
      b.google.refreshToken,
      '',
      'Even manually enabled tools must not inherit owner credentials',
    );
    assert.equal(b.homeAssistant.token, '');
    assert.equal(a.memory.sharedProfile, '');
    const memoryA = new Memory(a.memory, f.store, disabledEmbeddings);
    const memoryB = new Memory(b.memory, f.store, disabledEmbeddings);
    const ownerMemory = new Memory(original.memory, f.store, disabledEmbeddings);
    await ownerMemory.save('telegram:1', {
      text: 'Owner private secret',
      category: 'owner',
      tags: [],
    });
    await memoryA.save('salem:10', { text: 'Personal secret', category: 'personal', tags: [] });
    await memoryB.save('salem:-20', { text: 'Group secret', category: 'group', tags: [] });
    assert.deepEqual((await memoryA.catalog('salem:10')).tags, []);
    const result = await f.store.pool.query('SELECT id FROM memories WHERE session=$1', [
      'legacy-owner',
    ]);
    await assert.rejects(
      () => memoryA.read('salem:10', String(result.rows[0].id)),
      /not found in this profile/,
    );
    const all = await f.store.pool.query('SELECT session,text FROM memories ORDER BY id');
    assert.deepEqual(
      all.rows.map((row) => row.session),
      ['legacy-owner', 'salem:10', 'salem:-20'],
    );
    assert(!(await memoryA.catalog('salem:10')).categories.includes('owner'));
    assert(!(await memoryB.catalog('salem:-20')).categories.includes('personal'));
    const tools = new Tools(f.store, undefined, (name) => {
      const cap = toolCapability(name);
      return !cap || (a.telegram && ['web', 'transcription'].includes(cap));
    });
    registerGoogleTools(tools, new Google(f.config.google, f.config.timezone));
    registerHomeAssistantTools(
      tools,
      new HomeAssistant(f.config.homeAssistant),
      f.config.homeAssistant,
    );
    registerMemoryTools(tools, memoryA);
    assert.deepEqual(
      tools
        .definitions()
        .map((t) => t.name)
        .sort(),
      ['memories_get', 'memory_catalog', 'memory_read', 'memory_save'],
    );
    await assert.rejects(
      () =>
        tools.call(
          'calendar_list',
          {},
          { session: 'salem:10', jobId: 'test', signal: new AbortController().signal },
        ),
      /Unknown tool/,
    );
  } finally {
    await f.close();
  }
});

test('admin API requires authentication, redacts and encrypts secrets, preserves blank secrets, and manages pending chats', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  let validations = 0;
  const admin = new Admin(f.config, repository, async (token) => {
    validations++;
    if (token === '999:bad') throw new Error('invalid');
  });
  const access = new Access(repository, f.store);
  const server = createHttpServer(f.config, f.store, undefined, { access, admin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = {
    Authorization: `Bearer ${f.config.apiKey}`,
    'Content-Type': 'application/json',
  };
  const put = (path: string, value: unknown) =>
    fetch(base + '/v1/admin/' + path, { method: 'PUT', headers, body: JSON.stringify(value) });
  const get = async (path: string) =>
    (await (await fetch(base + '/v1/admin/' + path, { headers })).json()) as any;
  try {
    const page = await fetch(base + '/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const html = await page.text();
    assert.match(html, /Solo pendientes/);
    assert(!html.includes(f.config.apiKey));
    assert.equal((await fetch(base + '/v1/admin/profiles')).status, 401);
    assert.equal(
      (await fetch(base + '/v1/admin/bots/salem', { method: 'PUT', body: '{}' })).status,
      401,
    );
    await access.receive('salem', {
      update_id: 1,
      message: {
        chat: { id: 11, type: 'private', first_name: '<script>bad</script>' },
        from: { id: 11 },
        text: 'hello',
      },
    });
    let list = await get('profiles?pending=true&limit=1');
    assert.equal(list.total, 1);
    assert.equal(list.items[0].enabled, false);
    const input = {
      kind: 'user',
      label: 'Salem user',
      enabled: true,
      capabilities: ['web', 'transcription', 'calendar'],
      google: { clientId: 'client', clientSecret: 'google-secret', refreshToken: 'refresh-secret' },
      homeAssistant: {
        token: 'ha-secret',
        url: 'https://ha.example.com',
        locationEntity: '',
        geocodedLocationEntity: '',
      },
    };
    assert.equal((await put('profiles/salem/11', input)).status, 200);
    const details = await get('profiles/salem/11');
    assert.equal(details.hasGoogle, true);
    assert.equal(details.hasHomeAssistant, true);
    const serialized = JSON.stringify(details);
    for (const secret of ['google-secret', 'refresh-secret', 'ha-secret'])
      assert(!serialized.includes(secret));
    const stored = (
      await f.store.pool.query(
        'SELECT credentials FROM access_profiles WHERE bot=$1 AND chat_id=$2',
        ['salem', '11'],
      )
    ).rows[0].credentials;
    for (const secret of ['google-secret', 'refresh-secret', 'ha-secret'])
      assert(!stored.includes(secret));
    assert.equal((await repository.profile('salem', '11'))?.google?.refreshToken, 'refresh-secret');
    assert.equal(
      (
        await put('profiles/salem/11', {
          ...input,
          owner: true,
          google: { clientId: 'client', clientSecret: '', refreshToken: '' },
          homeAssistant: { ...input.homeAssistant, token: '' },
        })
      ).status,
      200,
    );
    const updated = (await repository.profile('salem', '11'))!;
    assert.equal(updated.owner, false);
    assert.equal(updated.google?.refreshToken, 'refresh-secret');
    assert.equal(updated.homeAssistant?.token, 'ha-secret');
    assert.equal((await get('profiles?pending=true')).total, 0);
    assert.equal(
      (await put('profiles/salem/12', { ...input, capabilities: ['unknown'] })).status,
      400,
    );
    assert.equal((await put('profiles/salem/-12', input)).status, 400);
    assert.equal((await put('bots/salem', { enabled: true })).status, 400);
    assert.equal((await put('bots/salem', { token: '999:bad', enabled: true })).status, 400);
    assert.equal(
      (await put('bots/salem', { token: '999:salem-secret', enabled: true })).status,
      200,
    );
    const bots = await get('bots');
    assert.equal(bots.items.find((b: any) => b.id === 'salem').configured, true);
    assert(!JSON.stringify(bots).includes('salem-secret'));
    assert.equal((await put('bots/salem', { token: '', enabled: false })).status, 200);
    assert.equal((await repository.bots())[0].token, '999:salem-secret');
    assert.equal(
      validations,
      2,
      'Saving a blank token must not replay token validation or mutate Telegram',
    );
    const storedToken = (await f.store.pool.query('SELECT token FROM managed_bots')).rows[0].token;
    assert(!storedToken.includes('salem-secret'));
    assert.equal(
      (await put('profiles/salem/11', { ...input, clearGoogle: true, clearHomeAssistant: true }))
        .status,
      200,
    );
    assert.equal((await repository.profile('salem', '11'))?.google?.refreshToken, '');
    const wrongKey = new PostgresAccess(f.store.pool, 'a-different-test-key');
    await assert.rejects(() => wrongKey.bots());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('managed webhook uses chat permissions for both ordinary messages and the welcome exception', async () => {
  const f = await fixture();
  f.config.telegram.transport = 'webhook';
  f.config.telegram.webhookSecret = 'webhook-secret';
  f.config.telegram.allowedUsers = ['1'];
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  const access = new Access(repository, f.store);
  const admin = new Admin(f.config, repository, async () => {});
  const server = createHttpServer(f.config, f.store, undefined, { access, admin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/telegram/webhook`;
  const message = {
    chat: { id: -100, type: 'group', title: 'Group with owner' },
    from: { id: 1 },
    text: 'hello',
  };
  const post = (update: unknown, secret = 'webhook-secret') =>
    fetch(url, {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(update),
    });
  try {
    assert.equal((await post({ update_id: 1, message }, 'wrong')).status, 401);
    assert.equal((await post({ update_id: 1, message })).status, 200);
    assert.equal(await f.store.claim([]), undefined, 'Owner presence must not grant group access');
    assert.equal((await repository.profile('zero', '-100'))?.enabled, false);
    const joined = {
      update_id: 2,
      message: { ...message, group_chat_created: true, text: undefined },
    };
    const accepted = (await (await post(joined)).json()) as any;
    const duplicate = (await (await post(joined)).json()) as any;
    assert.equal(accepted.jobId, duplicate.jobId);
    assert.equal((await f.store.job(accepted.jobId))?.session, 'telegram:-100');
    assert.equal((await repository.profile('zero', '-100'))?.enabled, false);
    await repository.saveProfile({ ...(await repository.profile('zero', '-100'))!, enabled: true });
    assert.ok(((await (await post({ update_id: 3, message })).json()) as any).jobId);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
