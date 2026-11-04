import { assistExposureFixture } from './assist-exposure-fixture.js';
import { registerPlacesTools } from '../src/adapters/inbound/places-tools.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { fixture } from './helpers.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresGroupMembers } from '../src/adapters/outbound/postgres-group-members.js';
import { Access } from '../src/application/access.js';
import { GroupMembers } from '../src/application/group-members.js';
import { GroupMembersAdmin } from '../src/adapters/inbound/group-members-admin.js';
import { Tools } from '../src/application/tool-registry.js';
import { registerHomeAssistantTools } from '../src/adapters/inbound/integration-tools.js';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { toolCapability } from '../src/domain/access.js';

const member = {
  userId: '12',
  name: 'Ana',
  username: '',
  present: true,
  observed: false,
  locationEntity: 'person.ana',
  geocodedLocationEntity: 'sensor.ana_address',
};
test('observed and manual group members preserve assignments, isolation, migration and deletion', async () => {
  const f = await fixture();
  try {
    const profiles = new PostgresAccess(f.store.db, f.config.apiKey);
    const repository = new PostgresGroupMembers(f.store.db);
    const service = new GroupMembers(repository);
    const access = new Access(profiles, f.store, async () => 'zero_bot', service);
    const update = (id: number, message: any) => ({
      update_id: id,
      message: { chat: { id: -10, type: 'supergroup', title: 'Family' }, ...message },
    });
    await access.receive(
      'zero',
      update(1, { from: { id: 12, first_name: 'Ana', username: 'ana' }, text: 'hello' }),
    );
    assert.equal((await repository.get('zero', '-10', '12'))?.observed, true);
    assert.equal(
      await profiles.profile('zero', '12'),
      undefined,
      'Discovering a group member must not create a private profile',
    );
    assert.equal(
      await f.store.claim([]),
      undefined,
      'Discovery does not authorize a pending group',
    );
    await repository.save('zero', '-10', member);
    await access.receive(
      'zero',
      update(2, {
        from: { id: 12, first_name: 'Ana updated' },
        new_chat_members: [
          { id: 13, first_name: 'Luis' },
          { id: 88, is_bot: true },
        ],
      }),
    );
    assert.equal((await repository.get('zero', '-10', '12'))?.locationEntity, 'person.ana');
    assert.equal((await repository.get('zero', '-10', '12'))?.name, 'Ana updated');
    assert.equal((await repository.list('zero', '-10', '', 0, 1)).total, 2);
    assert.equal((await repository.list('zero', '-10', 'Luis', 0, 20)).items[0]?.userId, '13');
    assert.equal((await repository.list('zero', '-10', '', 999, 20)).items.length, 0);
    await assert.rejects(() => service.locationEntities('helper', '-10', '12'));
    await assert.rejects(() => service.locationEntities('zero', '-20', '12'));
    await assert.rejects(() => service.locationEntities('zero', '-10', '13'));
    assert.deepEqual(await service.locationEntities('zero', '-10', '12'), {
      locationEntity: 'person.ana',
      geocodedLocationEntity: 'sensor.ana_address',
    });
    await access.receive(
      'zero',
      update(3, {
        sender_chat: { id: -10 },
        from: { id: 99, first_name: 'Anonymous' },
        text: 'hi',
      }),
    );
    assert.equal(await repository.get('zero', '-10', '99'), undefined);
    await access.receive('zero', update(4, { left_chat_member: { id: 12, first_name: 'Ana' } }));
    await assert.rejects(() => service.locationEntities('zero', '-10', '12'));
    await access.receive('zero', update(5, { new_chat_members: [{ id: 12, first_name: 'Ana' }] }));
    assert.equal((await repository.get('zero', '-10', '12'))?.locationEntity, 'person.ana');
    await access.receive('zero', update(6, { migrate_to_chat_id: -10010 }));
    assert.equal((await repository.get('zero', '-10010', '12'))?.locationEntity, 'person.ana');
    await repository.save('zero', '-10010', { ...member, locationEntity: 'person.destination' });
    await access.receive('zero', update(7, { migrate_to_chat_id: -10010 }));
    assert.equal(
      (await repository.get('zero', '-10010', '12'))?.locationEntity,
      'person.destination',
    );
    await profiles.removeProfile('zero', '-10010');
    assert.equal(await repository.get('zero', '-10010', '12'), undefined);
    await repository.remove('zero', '-10', '12');
    assert.equal(await repository.get('zero', '-10', '12'), undefined);
  } finally {
    await f.close();
  }
});

test('group member admin validates entity IDs, scopes reads and preserves metadata on manual edits', async () => {
  const f = await fixture();
  try {
    const profiles = new PostgresAccess(f.store.db, f.config.apiKey);
    const members = new PostgresGroupMembers(f.store.db);
    await profiles.discover('zero', '-10', 'Family', 'group');
    await members.observe('zero', '-10', {
      userId: '12',
      name: 'Ana',
      username: 'ana',
      present: false,
    });
    const admin = new GroupMembersAdmin(profiles, members);
    async function request(method: string, suffix: string, body?: unknown) {
      let status = 0,
        value: any;
      const path = '/v1/admin/profiles/zero/-10/members' + suffix;
      await admin.handle(
        { method, url: path } as IncomingMessage,
        path.split('?')[0],
        async () => body,
        (code, data) => {
          status = code;
          value = data;
        },
      );
      return { status, value };
    }
    assert.equal(
      (
        await request('PUT', '/12', {
          name: 'Ana',
          locationEntity: 'person.ana',
          geocodedLocationEntity: 'sensor.address',
        })
      ).status,
      200,
    );
    assert.equal((await request('POST', '', { userId: '12', name: 'Duplicate' })).status, 409);
    const saved = (await request('GET', '/12')).value;
    assert.equal(saved.present, false);
    assert.equal(saved.username, 'ana');
    assert.equal(saved.observed, true);
    await assert.rejects(() =>
      request('PUT', '/12', { name: 'Ana', locationEntity: 'light.invalid' }),
    );
    await assert.rejects(() => request('GET', '?limit=10000'));
    assert.equal((await request('GET', '?search=ana&limit=1')).value.total, 1);
    assert.equal((await request('GET', '/999')).status, 404);
    assert.equal((await request('DELETE', '/12')).status, 200);
    assert.equal((await request('GET', '/12')).status, 404);
  } finally {
    await f.close();
  }
});

test('group location tool defaults to authenticated sender and requires a member for anonymous messages', async () => {
  const config = { ...ConfigSchema.parse({}).homeAssistant, token: 'test-only' };
  const tools = new Tools({ async audit() {} });
  const calls: string[] = [];
  registerHomeAssistantTools(tools, new HomeAssistant(config, assistExposureFixture()), config, {
    async list() {
      return { items: [{ userId: '12', name: 'Ana' }], total: 1 };
    },
    async location(userId) {
      calls.push(userId);
      return { userId };
    },
  });
  const context = {
    session: 'telegram:-10',
    jobId: 'test',
    signal: AbortSignal.timeout(5000),
    telegramUserId: '12',
  };
  assert.equal(toolCapability('group_members_list'), 'homeAssistant');
  await tools.call('location_get', {}, context);
  await tools.call('location_get', { user_id: '13' }, context);
  assert.deepEqual(calls, ['12', '13']);
  await assert.rejects(() =>
    tools.call('location_get', {}, { ...context, telegramUserId: undefined }),
  );
  assert.deepEqual(await tools.call('group_members_list', {}, context), {
    items: [{ userId: '12', name: 'Ana' }],
    total: 1,
  });
});

test('named group locations resolve the requested member rather than the sender and reject ambiguity', async () => {
  const config = { ...ConfigSchema.parse({}).homeAssistant, token: 'test-only' };
  const tools = new Tools({ async audit() {} });
  const reads: string[] = [];
  let ambiguous = false;
  registerHomeAssistantTools(tools, new HomeAssistant(config, assistExposureFixture()), config, {
    async list(search) {
      assert.equal(search, 'Ken');
      return {
        items: [
          { userId: '12', name: 'Ken', present: true },
          ...(ambiguous ? [{ userId: '13', name: 'Ken', present: true }] : []),
        ],
        total: ambiguous ? 2 : 1,
      };
    },
    async location(userId) {
      reads.push(userId);
      return {
        location_available: true,
        zone: null,
        coordinates: { latitude: 0, longitude: 0 },
        coordinates_current: false,
        coordinates_age_seconds: 7200,
      };
    },
  });
  const context = {
    session: 'telegram:-10',
    jobId: 'test',
    signal: AbortSignal.timeout(5000),
    telegramUserId: '99',
  };
  const location = (await tools.call('location_get', { member_name: 'Ken' }, context)) as any;
  assert.deepEqual(reads, ['12']);
  assert.equal(location.subject_user_id, '12');
  assert.equal(location.location_available, true);
  assert.equal(location.zone, null);
  assert.deepEqual(location.coordinates, { latitude: 0, longitude: 0 });
  assert.equal(location.coordinates_age_seconds, 7200);
  registerPlacesTools(tools, {
    async search(_query: string, near: unknown) {
      assert.deepEqual(near, { latitude: 0, longitude: 0 });
      return [
        {
          name: 'Example restaurant',
          maps_url: 'https://www.google.com/maps/search/?api=1&query=Example+restaurant',
        },
      ];
    },
  } as any);
  const nearby = (await tools.call(
    'places_search',
    { query: 'restaurants', near: location.coordinates },
    context,
  )) as any;
  assert.ok(nearby.places[0].maps_url.startsWith('https://www.google.com/maps/'));
  ambiguous = true;
  await assert.rejects(
    tools.call('location_get', { member_name: 'Ken' }, context),
    /Several group members/,
  );
  assert.deepEqual(reads, ['12']);
});
