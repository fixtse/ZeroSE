import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantTasks } from '../src/adapters/outbound/home-assistant-tasks.js';
import { Google } from '../src/adapters/outbound/google.js';
import { withTaskProvider } from '../src/application/task-provider.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';

test('HA tasks use the selected list, preserve UIDs, and never replay a failed mutation through Google', async () => {
  const original = globalThis.fetch;
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let fail = false;
  globalThis.fetch = async (url, options) => {
    const request = { url: String(url), body: JSON.parse(String(options?.body)) };
    requests.push(request);
    assert.equal(request.body.entity_id, 'todo.personal');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer fixture-only');
    if (request.url.includes('get_items'))
      return Response.json({
        service_response: {
          'todo.personal': {
            items: [
              {
                uid: 'pending-id',
                summary: 'Same title',
                status: 'needs_action',
                description: 'notes',
              },
              { uid: 'done-id', summary: 'Same title', status: 'completed', due: '2026-10-26' },
            ],
          },
        },
      });
    return fail ? new Response('{}', { status: 503 }) : Response.json([]);
  };
  try {
    const config = ConfigSchema.parse({
      homeAssistant: {
        url: 'https://ha.fixture',
        token: 'fixture-only',
        taskProvider: 'home_assistant',
        taskListEntity: 'todo.personal',
      },
    });
    const direct = new Google(config.google, config.timezone);
    const selected = withTaskProvider(direct, new HomeAssistantTasks(config.homeAssistant));
    assert.equal(direct.enabled, false);
    assert.equal(selected.enabled, true);
    assert.deepEqual(
      (await selected.tasks()).map((item) => item.id),
      ['pending-id'],
    );
    assert.equal(((await selected.task('done-id')) as any).status, 'completed');
    await selected.createTask({ title: 'New task', notes: 'details', due: '2026-10-27' });
    assert.deepEqual(requests.at(-1)?.body, {
      entity_id: 'todo.personal',
      item: 'New task',
      description: 'details',
      due_date: '2026-10-27',
    });
    await selected.updateTask('pending-id', { status: 'completed', title: 'Renamed' });
    assert.deepEqual(requests.at(-1)?.body, {
      entity_id: 'todo.personal',
      item: 'pending-id',
      status: 'completed',
      rename: 'Renamed',
    });
    const before = requests.length;
    await assert.rejects(selected.deleteTask('Same title'), /not found/);
    assert.equal(requests.length, before + 1);
    fail = true;
    const count = requests.length;
    await assert.rejects(selected.createTask({ title: 'Uncertain result' }));
    assert.equal(requests.length, count + 1);
    assert(
      requests.every((request) => request.url.startsWith('https://ha.fixture/api/services/todo/')),
    );
    await assert.rejects(
      selected.createTask({ title: 'Bad date', due: 'tomorrow-ish' }),
      /valid due/,
    );
    assert.equal(requests.length, count + 1);
  } finally {
    globalThis.fetch = original;
  }
});
