import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  SchedulerSE,
  schedulerSeEvent,
  schedulerSeTaskId,
} from '../src/adapters/outbound/schedulerse.js';
import type { NotificationRule } from '../src/domain/notification-rule.js';

test('SchedulerSE uses stable generations, cancels previous pending tasks, and never retries uncertain writes', async () => {
  const calls: string[] = [];
  let fail = false;
  const rule = {
    id: '00000000-0000-4000-8000-000000000001',
    generation: 1,
    kind: 'timer',
    status: 'active',
    message: 'Tea',
    next_at: new Date(Date.now() + 60000).toISOString(),
    repeat_seconds: null,
  } as NotificationRule;
  const callbackUrl = 'http://127.0.0.1:8788/v1/triggers/schedulerse-events';
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    calls.push(req.method + ' ' + req.url);
    if (req.url === '/api/agent/v1/connection')
      return res.end(
        JSON.stringify({
          delivery_mode: 'webhook',
          webhook_url: callbackUrl,
          has_webhook_authorization: true,
        }),
      );
    if (req.method === 'GET') return res.end(JSON.stringify({ status: 'pending' }));
    if (req.method === 'DELETE') {
      res.writeHead(204);
      return res.end();
    }
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const value = JSON.parse(Buffer.concat(parts).toString());
    assert.equal(value.context.generation, fail ? 0 : rule.generation);
    assert.equal(value.run_at, rule.next_at);
    if (fail) {
      res.writeHead(503);
      return res.end('{}');
    }
    res.writeHead(201);
    res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const scheduler = new SchedulerSE(
    { url: `http://127.0.0.1:${(server.address() as any).port}`, token: 'test-token', callbackUrl },
    async () => rule,
  );
  try {
    await scheduler.ready();
    await scheduler.configure(rule);
    assert.deepEqual(calls.slice(1), [
      'GET /api/agent/v1/tasks/' + schedulerSeTaskId(rule.id, 0),
      'DELETE /api/agent/v1/tasks/' + schedulerSeTaskId(rule.id, 0),
      'POST /api/agent/v1/tasks',
    ]);
    fail = true;
    calls.length = 0;
    await assert.rejects(scheduler.configure({ ...rule, generation: 0 }), /503/);
    assert.equal(calls.length, 1);
    await assert.rejects(scheduler.configure({ ...rule, kind: 'alert' }), /cannot monitor/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('SchedulerSE occurrences map to stable UUIDs and reject mismatched routing', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const task = {
    id: schedulerSeTaskId(id, 2),
    interval_seconds: 60,
    context: { integration: 'zero' as const, rule_id: id, generation: 2 },
  };
  const event = {
    event_id: task.id + ':2026-10-25T12:00:00Z',
    scheduled_at: '2026-10-25T12:00:00Z',
    task,
  };
  const value = schedulerSeEvent(event);
  assert.equal(value.event_id, schedulerSeEvent(event).event_id);
  assert.match(value.event_id, /^[a-f0-9-]{36}$/);
  assert.equal(value.next_at, '2026-10-25T12:01:00.000Z');
  assert.throws(
    () => schedulerSeEvent({ ...event, task: { ...task, id: 'foreign-task' } }),
    /identity/,
  );
});
