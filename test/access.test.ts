import { assistExposureFixture } from './assist-exposure-fixture.js';
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
  bot: 'helper',
  chatId,
  kind,
  label: chatId,
  enabled: false,
  capabilities: ['web', 'transcription'],
  owner: false,
});

test('discovery records Helper contacts as pending, never inherits sender permission, and isolates bot dedupe keys', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  const access = new Access(repository, f.store, async () => 'del_chat_ai_bot');
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
    assert.equal(await access.receive('helper', update(1, 10)), undefined);
    let pending = await repository.profile('helper', '10');
    assert.equal(pending?.enabled, false);
    assert.deepEqual(pending?.capabilities, ['web', 'transcription']);
    assert.equal(await f.store.claim([]), undefined);
    await repository.saveProfile({ ...pending!, enabled: true });
    const accepted = await access.receive('helper', update(2, 10));
    assert.equal(accepted?.session, 'helper:10');
    const duplicate = await access.receive('helper', update(2, 10));
    assert.equal(duplicate?.id, accepted?.id);
    const otherBot = await access.receive('zero', update(2, 10));
    assert.equal(otherBot, undefined, 'Helper permission must not authorize Zero');
    const group = update(3, -10, 'group');
    group.message.from.id = 10;
    assert.equal(
      await access.receive('helper', group),
      undefined,
      'Allowed user must not authorize their group',
    );
    assert.equal((await repository.profile('helper', '-10'))?.enabled, false);
    const join = {
      ...group,
      update_id: 4,
      message: { ...group.message, text: undefined, group_chat_created: true },
    };
    assert.equal(
      (await access.receive('helper', join))?.session,
      'helper:-10',
      'Only membership events bypass access',
    );
    assert.equal(
      (await repository.profile('helper', '-10'))?.enabled,
      false,
      'Welcome must not activate the group',
    );
    await repository.saveProfile({ ...profile('-10', 'group'), enabled: true });
    assert.ok(
      await access.receive('helper', {
        ...group,
        update_id: 5,
        message: {
          ...group.message,
          text: '@del_chat_ai_bot',
          entities: [{ type: 'mention', offset: 0, length: 16 }],
        },
      }),
    );
    await repository.saveProfile({ ...profile('-10', 'group'), enabled: false });
    assert.equal(await access.receive('helper', { ...group, update_id: 6 }), undefined);
    assert.equal((await repository.profiles('', 0, 20, true)).total, 2);
    assert.equal((await repository.profiles('A group', 0, 1, true)).items.length, 1);
    assert.equal((await repository.profiles('', 99, 20, true)).total, 2);
    await assert.rejects(() => access.receive('helper', { update_id: 'wrong' }), /Invalid update/);
  } finally {
    await f.close();
  }
});

test('Helper groups accept mentions and direct replies to their own bot messages', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  let lookups = 0;
  const access = new Access(repository, f.store, async () => {
    lookups++;
    return 'del_chat_ai_bot';
  });
  const mention = { type: 'mention', offset: 0, length: 16 };
  const addressed = { text: '@del_chat_ai_bot', entities: [mention] };
  const video = { file_id: 'video-file' };
  try {
    await repository.saveProfile({ ...profile('-10', 'group'), enabled: true });
    let updateId = 100;
    for (const type of ['group', 'supergroup']) {
      for (const message of [
        { text: 'hello' },
        { text: 'hello', reply_to_message: { from: { is_bot: true, username: 'another_bot' } } },
        {
          text: 'hello',
          reply_to_message: { from: { is_bot: false, username: 'del_chat_ai_bot' } },
        },
        { text: 'hello', external_reply: { from: { is_bot: true, username: 'del_chat_ai_bot' } } },
        { video, forward_origin: { type: 'user' } },
        { text: 'transcribe', reply_to_message: { video } },
        { text: 'hello', reply_to_message: { from: { is_bot: true }, ...addressed } },
        { text: '@another_bot', entities: [{ ...mention, length: 12 }] },
        { text: '@del_chat_ai_bot', entities: [{ ...mention, type: 'code' }] },
        { text: '/transcribe', entities: [{ type: 'bot_command', offset: 0, length: 11 }] },
      ]) {
        assert.equal(
          await access.receive('helper', {
            update_id: updateId++,
            message: { chat: { id: -10, type }, ...message },
          }),
          undefined,
        );
      }
      for (const message of [
        addressed,
        {
          text: 'hello',
          reply_to_message: { from: { is_bot: true, username: 'DEL_CHAT_AI_BOT' } },
        },
        { video, reply_to_message: { from: { is_bot: true, username: 'del_chat_ai_bot' } } },
        { ...addressed, reply_to_message: { video } },
        { text: '😀 @DEL_CHAT_AI_BOT', entities: [{ ...mention, offset: 3 }] },
        { video, caption: addressed.text, caption_entities: addressed.entities },
        {
          video,
          caption: addressed.text,
          caption_entities: addressed.entities,
          forward_origin: { type: 'user' },
        },
        {
          text: '/transcribe@del_chat_ai_bot',
          entities: [{ type: 'bot_command', offset: 0, length: 27 }],
        },
      ]) {
        const job = await access.receive('helper', {
          update_id: updateId++,
          message: { chat: { id: -10, type }, ...message },
        });
        assert.equal(job?.session, 'helper:-10');
        assert.deepEqual(
          job?.payload.message.reply_to_message,
          'reply_to_message' in message ? message.reply_to_message : undefined,
        );
      }
    }
    await repository.saveProfile({
      ...profile('-10', 'group'),
      enabled: true,
      respondToReplies: false,
    });
    assert.equal((await repository.profile('helper', '-10'))?.respondToReplies, false);
    for (const type of ['group', 'supergroup']) {
      const message = {
        chat: { id: -10, type },
        text: 'hello',
        reply_to_message: { from: { is_bot: true, username: 'del_chat_ai_bot' } },
      };
      assert.equal(await access.receive('helper', { update_id: updateId++, message }), undefined);
      assert.ok(
        await access.receive('helper', {
          update_id: updateId++,
          message: { ...message, ...addressed },
        }),
      );
    }
    await repository.saveProfile({ ...profile('-10', 'group'), enabled: true });
    assert.equal(
      (await repository.profile('helper', '-10'))?.respondToReplies,
      false,
      'Omitting the setting preserves it',
    );
    await repository.saveProfile({
      ...profile('-10', 'group'),
      bot: 'zero',
      enabled: true,
      respondToReplies: false,
    });
    const zeroReply = {
      chat: { id: -10, type: 'supergroup' },
      text: 'hello',
      reply_to_message: { from: { is_bot: true, username: 'del_chat_ai_bot' } },
    };
    assert.equal(
      await access.receive('zero', { update_id: updateId++, message: zeroReply }),
      undefined,
    );
    assert.ok(
      await access.receive('zero', {
        update_id: updateId++,
        message: { ...zeroReply, ...addressed },
      }),
    );
    const beforePrivate = lookups;
    await repository.saveProfile({ ...profile('10'), enabled: true });
    assert.ok(
      await access.receive('helper', {
        update_id: updateId++,
        message: {
          chat: { id: 10, type: 'private' },
          from: { id: 10 },
          video,
        },
      }),
    );
    assert.equal(lookups, beforePrivate, 'Private messages do not need a bot username');
    assert.equal(lookups, 24, 'Unaddressed messages never fetch the bot identity');
  } finally {
    await f.close();
  }
});

test('group migration carries access and encrypted settings without enqueueing service messages', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  const access = new Access(repository, f.store);
  const source: AccessProfile = {
    ...profile('-10', 'group'),
    enabled: true,
    label: 'Original group',
    voiceReplies: false,
    respondToReplies: false,
    memoryPolicy: 'automatic',
    capabilities: ['transcription', 'homeAssistant'],
    memoryMode: 'simple',
    timezone: 'Europe/London',
    homeAssistant: { ...f.config.homeAssistant, token: 'group-private-token' },
  };
  const migration = (chatId: number, extra: object) => ({
    update_id: 1,
    message: {
      chat: { id: chatId, type: chatId === -10 ? 'group' : 'supergroup' },
      ...extra,
    },
  });
  try {
    await repository.saveProfile(source);
    assert.equal(
      await access.receive('helper', migration(-10, { migrate_to_chat_id: -10020 })),
      undefined,
    );
    const migrated = (await repository.profile('helper', '-10020'))!;
    assert.deepEqual(migrated, { ...source, chatId: '-10020', context: '', contextRevision: 0 });
    assert.equal(await f.store.claim([]), undefined, 'Migration must not reach the agent');
    assert.equal(await repository.profile('zero', '-10020'), undefined);
    assert.equal((await repository.profile('helper', '-10'))?.enabled, true);
    await repository.saveProfile({ ...migrated, enabled: false });
    await access.receive('helper', migration(-10020, { migrate_from_chat_id: -10 }));
    assert.equal(
      (await repository.profile('helper', '-10020'))?.enabled,
      false,
      'Duplicate migration must not override administrator decisions',
    );
    await access.receive('helper', migration(-10030, { migrate_from_chat_id: -10 }));
    assert.equal(
      (await repository.profile('helper', '-10030'))?.enabled,
      true,
      'The destination-side service message must also carry permissions',
    );
    await repository.removeProfile('helper', '-10030');
    await access.receive('helper', migration(-10030, { migrate_from_chat_id: -10 }));
    assert.equal(
      await repository.profile('helper', '-10030'),
      undefined,
      'A repeated migration must not restore a deleted destination',
    );
    await repository.saveProfile({ ...source, enabled: false });
    await access.receive('helper', migration(-10, { migrate_to_chat_id: -10040 }));
    assert.equal((await repository.profile('helper', '-10040'))?.enabled, false);
    await access.receive('helper', migration(-10050, { migrate_from_chat_id: -999 }));
    assert.equal(await repository.profile('helper', '-10050'), undefined);
    await access.receive('helper', migration(-10, { migrate_to_chat_id: 'invalid' }));
    assert.equal(await f.store.claim([]), undefined);
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
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
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
    await memoryA.save('helper:10', { text: 'Personal secret', category: 'personal', tags: [] });
    await memoryB.save('helper:-20', { text: 'Group secret', category: 'group', tags: [] });
    assert.deepEqual((await memoryA.catalog('helper:10')).tags, []);
    const result = await f.store.pool.query('SELECT id FROM memories WHERE session=$1', [
      'legacy-owner',
    ]);
    await assert.rejects(
      () => memoryA.read('helper:10', String(result.rows[0].id)),
      /not found in this profile/,
    );
    const all = await f.store.pool.query('SELECT session,text FROM memories ORDER BY id');
    assert.deepEqual(
      all.rows.map((row) => row.session),
      ['legacy-owner', 'helper:10', 'helper:-20'],
    );
    assert(!(await memoryA.catalog('helper:10')).categories.includes('owner'));
    assert(!(await memoryB.catalog('helper:-20')).categories.includes('personal'));
    const tools = new Tools(f.store, undefined, (name) => {
      const cap = toolCapability(name);
      return !cap || (a.telegram && ['web', 'transcription'].includes(cap));
    });
    registerGoogleTools(tools, new Google(f.config.google, f.config.timezone));
    registerHomeAssistantTools(
      tools,
      new HomeAssistant(f.config.homeAssistant, assistExposureFixture()),
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
          { session: 'helper:10', jobId: 'test', signal: new AbortController().signal },
        ),
      /Unknown tool/,
    );
  } finally {
    await f.close();
  }
});

test('admin API requires authentication, redacts and encrypts secrets, preserves blank secrets, and manages pending chats', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  const admin = new Admin(f.config, repository, async () => {});
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
    for (const path of ['/admin/advance', '/admin/advanced', '/admin/advanced/'])
      assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(base + '/v1/admin/profiles')).status, 401);
    assert.equal(
      (await fetch(base + '/v1/admin/bots/helper', { method: 'PUT', body: '{}' })).status,
      401,
    );
    await access.receive('helper', {
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
      label: 'Helper user',
      respondToReplies: false,
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
    assert.equal((await put('profiles/helper/11', input)).status, 200);
    const details = await get('profiles/helper/11');
    assert.equal(details.respondToReplies, false);
    assert.equal(details.hasGoogle, true);
    assert.equal(details.hasHomeAssistant, true);
    const serialized = JSON.stringify(details);
    for (const secret of ['google-secret', 'refresh-secret', 'ha-secret'])
      assert(!serialized.includes(secret));
    const stored = (
      await f.store.pool.query(
        'SELECT credentials FROM access_profiles WHERE bot=$1 AND chat_id=$2',
        ['helper', '11'],
      )
    ).rows[0].credentials;
    for (const secret of ['google-secret', 'refresh-secret', 'ha-secret'])
      assert(!stored.includes(secret));
    assert.equal(
      (await repository.profile('helper', '11'))?.google?.refreshToken,
      'refresh-secret',
    );
    assert.equal(
      (
        await put('profiles/helper/11', {
          ...input,
          owner: true,
          google: { clientId: 'client', clientSecret: '', refreshToken: '' },
          homeAssistant: { ...input.homeAssistant, token: '' },
        })
      ).status,
      200,
    );
    const updated = (await repository.profile('helper', '11'))!;
    assert.equal(updated.owner, false);
    assert.equal(updated.google?.refreshToken, 'refresh-secret');
    assert.equal(updated.homeAssistant?.token, 'ha-secret');
    assert.equal((await get('profiles?pending=true')).total, 0);
    const status = await fetch(base + '/v1/admin/profiles/helper/11', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { enabled: false, approved: true });
    assert.equal((await get('profiles?pending=true')).total, 0);
    const inactive = await get('profiles/helper/11');
    assert.equal(inactive.enabled, false);
    assert.equal(inactive.approved, true);
    assert.equal(inactive.label, input.label);
    assert.deepEqual(inactive.capabilities, input.capabilities);
    assert.equal(
      (await repository.profile('helper', '11'))?.google?.refreshToken,
      'refresh-secret',
    );
    const reactivated = await fetch(base + '/v1/admin/profiles/helper/11', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(reactivated.status, 200);
    assert.deepEqual(await reactivated.json(), { enabled: true, approved: true });

    assert.equal(
      (await put('profiles/helper/12', { ...input, capabilities: ['unknown'] })).status,
      400,
    );
    assert.equal((await put('profiles/helper/-12', input)).status, 400);
    assert.equal(
      (await put('bots/helper', { enabled: true })).status,
      404,
      'Retired global bot settings are not routed',
    );
    assert.equal(
      (await put('profiles/helper/11', { ...input, clearGoogle: true, clearHomeAssistant: true }))
        .status,
      200,
    );
    assert.equal((await repository.profile('helper', '11'))?.google?.refreshToken, '');
    const wrongKey = new PostgresAccess(f.store.db, 'a-different-test-key');
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
  f.config.telegram.token = '111:fixture-zero';
  f.config.telegram.allowedUsers = ['1'];
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  const access = new Access(repository, f.store);
  const admin = new Admin(f.config, repository, async () => {});
  const server = createHttpServer(f.config, f.store, undefined, { access, admin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/telegram/assistants/zero/webhook`;
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
