import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { ProfileMemoryAdmin } from '../src/adapters/inbound/profile-memory-admin.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import {
  ProfileMemories,
  memoryProfile,
  ProfileMemoryError,
} from '../src/application/profile-memories.js';
import { Access, scopedConfig, type AccessRepository } from '../src/application/access.js';
import type { MemoryPort } from '../src/application/ports.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { telegramSession, type AccessProfile } from '../src/domain/access.js';
import type { MemoryFragment, MemoryMatch } from '../src/domain/models.js';
import { fixture } from './helpers.js';

function setup() {
  const config = ConfigSchema.parse({ memory: { sharedProfile: 'owner-memory' } });
  const alice: AccessProfile = {
    bot: 'zero',
    chatId: '101',
    kind: 'user',
    label: 'Alice',
    enabled: true,
    owner: false,
    capabilities: [],
    memoryMode: 'simple',
  };
  const bob: AccessProfile = { ...alice, chatId: '202', label: 'Bob' };
  const owner: AccessProfile = { ...alice, chatId: '303', label: 'Owner', owner: true };
  const group: AccessProfile = { ...alice, chatId: '-404', kind: 'group', label: 'Group' };
  const ha: AccessProfile = { ...alice, chatId: 'ha:' + 'a'.repeat(32), label: 'HA user' };
  const profiles = [alice, bob, owner, group, ha];
  const lookup = {
    async profile(bot: string, chat: string) {
      return profiles.find((p) => p.bot === bot && p.chatId === chat);
    },
  };
  const reads: string[] = [],
    saves: { key: string; value: MemoryFragment }[] = [],
    deletes: { key: string; ids: string[] }[] = [],
    queries: unknown[][] = [];
  const values = new Map<string, MemoryMatch>([
    [
      'telegram:101:1',
      {
        id: '1',
        text: 'Alice prefers tea.',
        summary: null,
        superseded_by: null,
        similarity: 1,
        metadata: {
          category: 'Preferences',
          tags: ['tea'],
          created_at: '2026-10-27T10:00:00.000Z',
        },
      },
    ],
    [
      'telegram:202:2',
      {
        id: '2',
        text: 'Private Bob fact',
        summary: null,
        superseded_by: null,
        similarity: 1,
        metadata: { category: 'Private', tags: [], created_at: '2026-10-27T10:00:00.000Z' },
      },
    ],
  ]);
  const repository = {
    async readMemory(key: string, id: string) {
      reads.push(key);
      return values.get(key + ':' + id);
    },
  };
  const data = {
    async memories(...args: [string, string, string | undefined, number, number]) {
      queries.push(args);
      return { items: [], total: 0, next_offset: null };
    },
    async forget(key: string, ids: string[]) {
      deletes.push({ key, ids });
      return ids.length;
    },
  };
  const memories = new ProfileMemories(repository, data, async (profile) => {
    const effective = await memoryProfile(profile, lookup, async () => ({
      ['a'.repeat(32)]: '101',
    }));
    const scoped = scopedConfig(config, effective);
    return {
      key: scoped.memory.sharedProfile || telegramSession(effective.bot, effective.chatId),
      enabled: scoped.memory.mode !== 'none',
      shared: !!scoped.memory.sharedProfile,
      linked: effective !== profile,
      memory: {
        async save(key: string, value: MemoryFragment) {
          saves.push({ key, value });
          return { saved: true };
        },
      } as MemoryPort,
    };
  });
  const admin = new ProfileMemoryAdmin(lookup, memories);
  return {
    config,
    alice,
    bob,
    owner,
    group,
    ha,
    lookup,
    memories,
    admin,
    reads,
    saves,
    deletes,
    queries,
    values,
  };
}

async function request(admin: ProfileMemoryAdmin, suffix: string, method = 'GET', body?: unknown) {
  const url = '/v1/admin/profiles/' + suffix;
  let status = 0,
    value: any;
  const handled = await admin.handle(
    { method, url } as IncomingMessage,
    url.split('?')[0],
    async () => body,
    (code, result) => {
      status = code;
      value = result;
    },
  );
  return { handled, status, value };
}

test('profile memories derive their scope from saved users, bots, groups, owner aliases and HA bindings', async () => {
  const f = setup();
  assert.equal(
    (
      await request(
        f.admin,
        'zero/101/memories?search=tea&category=Preferences&offset=20&limit=10&session=telegram:202',
      )
    ).status,
    200,
  );
  // Administrators retain scoped access to expired records for review and deletion.
  assert.deepEqual(f.queries[0], ['telegram:101', 'tea', 'Preferences', 20, 10, true]);
  assert.equal((await request(f.admin, 'zero/303/memories')).value.shared, true);
  assert.equal(f.queries.at(-1)![0], 'owner-memory');
  await request(f.admin, 'zero/-404/memories');
  assert.equal(f.queries.at(-1)![0], 'telegram:-404');
  const linked = await request(f.admin, 'zero/' + f.ha.chatId + '/memories');
  assert.equal(linked.value.linked, true);
  assert.equal(f.queries.at(-1)![0], 'telegram:101');
  assert.equal((await request(f.admin, 'helper/101/memories')).status, 404);
  assert.equal((await request(f.admin, 'zero/999/memories')).status, 404);
  assert.equal((await request(f.admin, 'zero/101/context')).handled, false);
});

test('foreign or missing memories cannot be read, corrected or deleted through another profile', async () => {
  const f = setup();
  assert.equal((await request(f.admin, 'zero/101/memories/1')).value.text, 'Alice prefers tea.');
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const result = await request(f.admin, 'zero/101/memories/2', method, {
      text: 'Wrong user',
      category: 'Preferences',
      tags: [],
    });
    assert.equal(result.status, 404);
  }
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.deletes, []);
  assert.equal((await request(f.admin, 'zero/202/memories/2')).value.text, 'Private Bob fact');
});

test('creation and corrections use Zero memory and exact scoped supersession; disabled memory remains inspectable and erasable', async () => {
  const f = setup();
  const fragment = {
    text: 'The user now prefers coffee.',
    category: 'Preferences',
    tags: ['coffee'],
  };
  assert.equal((await request(f.admin, 'zero/101/memories', 'POST', fragment)).status, 200);
  assert.equal(f.saves[0].key, 'telegram:101');
  assert.equal((await request(f.admin, 'zero/101/memories/1', 'PUT', fragment)).status, 200);
  assert.deepEqual(f.saves.at(-1)!.value.supersedes, ['1']);
  f.values.get('telegram:101:1')!.superseded_by = '3';
  const savedCount = f.saves.length;
  assert.equal((await request(f.admin, 'zero/101/memories/1', 'PUT', fragment)).status, 409);
  assert.equal(f.saves.length, savedCount);
  f.alice.memoryMode = 'none';
  assert.equal((await request(f.admin, 'zero/101/memories')).value.enabled, false);
  assert.equal((await request(f.admin, 'zero/101/memories/1')).status, 200);
  assert.equal((await request(f.admin, 'zero/101/memories', 'POST', fragment)).status, 400);
  assert.equal((await request(f.admin, 'zero/101/memories/1', 'DELETE')).value.deleted, 1);
  assert.deepEqual(f.deletes[0], { key: 'telegram:101', ids: ['1'] });
});

test('memory lists and details are bounded and callers cannot supply storage identities or arbitrary supersessions', async () => {
  const f = setup();
  f.values.get('telegram:101:1')!.text = 'x'.repeat(16001);
  const first = await request(f.admin, 'zero/101/memories/1');
  assert.equal(first.value.text.length, 8000);
  assert.equal(first.value.next_offset, 8000);
  const last = await request(f.admin, 'zero/101/memories/1?text_offset=16000');
  assert.equal(last.value.text, 'x');
  assert.equal(last.value.next_offset, null);
  assert.equal((await request(f.admin, 'zero/101/memories/1?text_offset=20000')).status, 400);
  await assert.rejects(request(f.admin, 'zero/101/memories?limit=51'));
  await assert.rejects(request(f.admin, 'zero/101/memories?offset=-1'));
  await assert.rejects(
    request(f.admin, 'zero/101/memories', 'POST', {
      text: 'Valid',
      category: 'General',
      session: 'telegram:202',
    }),
  );
  await assert.rejects(
    request(f.admin, 'zero/101/memories', 'POST', {
      text: 'Valid',
      category: 'General',
      supersedes: ['2'],
    }),
  );
  assert.equal((await request(f.admin, 'zero/101/memories/9999999999999999999')).status, 400);
  assert.equal((await request(f.admin, 'zero/101/memories', 'DELETE')).status, 405);
});

test('stale HA bindings never fall through to a different user or group memory', async () => {
  const f = setup();
  assert.equal(await memoryProfile(f.ha, f.lookup, async () => ({})), f.ha);
  await assert.rejects(
    memoryProfile(f.ha, f.lookup, async () => ({ ['a'.repeat(32)]: '999' })),
    ProfileMemoryError,
  );
  await assert.rejects(
    memoryProfile(f.ha, f.lookup, async () => ({ ['a'.repeat(32)]: '-404' })),
    ProfileMemoryError,
  );
  assert.equal(
    await memoryProfile(f.alice, f.lookup, async () => {
      throw new Error('Telegram must not need HA bindings');
    }),
    f.alice,
  );
});

test('HTTP memory management requires the existing admin authorization before profile access', async () => {
  const f = setup();
  const storage = await fixture();
  const repository = f.lookup as unknown as AccessRepository;
  const admin = new Admin(
    storage.config,
    repository,
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    f.admin,
  );
  const server = createHttpServer(storage.config, storage.store, undefined, {
    access: new Access(repository, storage.store),
    admin,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    const endpoint = base + '/v1/admin/profiles/zero/101/memories';
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint + '/1', { method: 'DELETE' })).status, 401);
    assert.deepEqual(f.queries, []);
    assert.deepEqual(f.deletes, []);
    assert.equal(
      (await fetch(endpoint, { headers: { Authorization: 'Bearer ' + storage.config.apiKey } }))
        .status,
      200,
    );
    assert.equal(f.queries[0][0], 'telegram:101');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await storage.close();
  }
});
