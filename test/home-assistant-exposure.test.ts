import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import { HomeAssistantTasks } from '../src/adapters/outbound/home-assistant-tasks.js';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { HomeAssistantExposure } from '../src/adapters/outbound/home-assistant-exposure.js';
import { HomeAssistantRuleScheduler } from '../src/adapters/outbound/ha-rule-scheduler.js';
import { assistExposureFixture } from './assist-exposure-fixture.js';

test('specialized discovery, reads and history use current Assist exposure, ignoring retired lists and own-location assignment', async (t) => {
  const config = ConfigSchema.parse({
    homeAssistant: {
      url: 'https://ha.example',
      token: 'test-only',
      sensorEntities: ['sensor.hidden', 'person.hidden'],
      locationEntity: 'person.hidden',
    },
  }).homeAssistant;
  let exposed = ['sensor.visible', 'person.visible'];
  const requests: string[] = [];
  const states = ['sensor.visible', 'sensor.hidden', 'person.visible', 'person.hidden'].map(
    (entity_id) => ({
      entity_id,
      state: '12',
      attributes: { friendly_name: entity_id },
    }),
  );
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requests.push(url);
    return Response.json(
      url.endsWith('/states')
        ? states
        : (states.find((state) => url.endsWith(state.entity_id)) ?? []),
    );
  });
  const ha = new HomeAssistant(
    config,
    assistExposureFixture(() => exposed),
  );
  assert.deepEqual(
    (await ha.sensors()).map((state: any) => state.entity_id),
    ['sensor.visible'],
  );
  assert.deepEqual(
    (await ha.locationEntities('', 0, 10)).items.map((item: any) => item.entity_id),
    ['person.visible'],
  );
  assert.deepEqual(
    (
      await ha.entityCatalog({ search: '', offset: 0, limit: 10 }, AbortSignal.timeout(1000))
    ).items.map((item: any) => item.id),
    exposed,
  );
  await ha.sensor('sensor.visible');
  const before = requests.length;
  await assert.rejects(ha.sensor('sensor.hidden'), /not exposed/);
  await assert.rejects(ha.location(), /not exposed/);
  await assert.rejects(ha.distance('person.visible', 'person.hidden'), /not exposed/);
  await assert.rejects(ha.history('sensor.hidden', '2026-11-01', '2026-11-02'), /not exposed/);
  assert.equal(requests.length, before);
  exposed = [];
  await assert.rejects(ha.sensor('sensor.visible'), /not exposed/);
  assert.equal((await ha.sensors()).length, 0);
  const scheduler = new HomeAssistantRuleScheduler(
    config,
    assistExposureFixture(() => exposed),
  );
  assert.equal(
    await scheduler.permitsCondition({
      entity_id: 'sensor.visible',
      operator: 'above',
      value: 1,
      hold_seconds: 0,
    }),
    false,
  );
});

test('exposure checks batch bounded IDs, use HA control permissions, and fail closed on unavailable or malformed responses', async () => {
  const config = ConfigSchema.parse({}).homeAssistant;
  const sizes: number[] = [];
  const exposure = new HomeAssistantExposure(config, async (_config, command) => {
    sizes.push((command.entity_ids as string[]).length);
    assert.equal(command.control, true);
    return command.entity_ids;
  });
  await exposure.assert(
    Array.from({ length: 205 }, (_, index) => `sensor.item_${index}`),
    undefined,
    true,
  );
  assert.deepEqual(sizes, [100, 100, 5]);
  await assert.rejects(
    new HomeAssistantExposure(config, async () => ['sensor.other']).assert(['sensor.a']),
    /Invalid Assist/,
  );
  await assert.rejects(
    new HomeAssistantExposure(config, async () => {
      throw new Error('Unavailable');
    }).assert(['sensor.a']),
    /Unavailable/,
  );
});

test('assigned weather, shopping and task entities do not grant read or write access', async (t) => {
  const config = ConfigSchema.parse({
    homeAssistant: {
      url: 'https://ha.example',
      token: 'test-only',
      shoppingListEntity: 'todo.shopping',
      taskListEntity: 'todo.tasks',
      weatherEntity: 'weather.home',
    },
  }).homeAssistant;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({});
  });
  const denied = assistExposureFixture([]);
  const ha = new HomeAssistant(config, denied);
  await assert.rejects(ha.shopping(), /not exposed/);
  await assert.rejects(ha.changeShopping('add', 'Milk'), /not exposed/);
  await assert.rejects(ha.forecast(), /not exposed/);
  const tasks = new HomeAssistantTasks(config, denied);
  await assert.rejects(tasks.tasks(), /not exposed/);
  await assert.rejects(tasks.createTask({ title: 'Task' }), /not exposed/);
  assert.equal(requests, 0);
});
