import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { modelAllowsApplicationTool } from '../src/domain/ai-tools.js';
import { Tools } from '../src/application/tool-registry.js';

test('GPT-5 and later omit external web lookup tools while retaining image search and integrations', () => {
  for (const model of [
    'gpt-5',
    'gpt5',
    'gpt-5-mini',
    'gpt-5.1-codex',
    'gpt-5.5-2026-10-01',
    'gpt-6-luna',
    'gpt-10',
    'openai/gpt-5',
    'openai/gpt-6:online',
    'GPT-5.1',
  ]) {
    assert.equal(modelAllowsApplicationTool(model, 'url_read'), false, model);
    assert.equal(modelAllowsApplicationTool(model, 'web_search'), false, model);
    for (const tool of ['image_search', 'calendar_list', 'sensor_get', 'places_search'])
      assert.equal(modelAllowsApplicationTool(model, tool), true, model + ': ' + tool);
  }
});

test('older, unnamed and unrecognized models retain external web tools', () => {
  for (const model of [
    undefined,
    '',
    'gpt-4',
    'gpt-4o',
    'openai/gpt-4.1',
    'claude-sonnet',
    'llama3',
    'my-gpt-5-deployment',
    'ai_task.gpt_5',
    'gpt-oss-120b',
  ]) {
    assert.equal(modelAllowsApplicationTool(model, 'url_read'), true, String(model));
    assert.equal(modelAllowsApplicationTool(model, 'web_search'), true, String(model));
  }
});

test('model filtering removes definitions and blocks stale calls without exposing disallowed tools', async () => {
  const context = {
    session: 'test',
    jobId: 'job',
    signal: AbortSignal.timeout(1000),
    aiModel: 'gpt-5',
  };
  let calls = 0;
  const tools = new Tools(
    { async audit() {} },
    async (name, current) => modelAllowsApplicationTool(current.aiModel, name),
    (name) => modelAllowsApplicationTool(context.aiModel, name),
  );
  for (const name of ['url_read', 'web_search', 'image_search'])
    tools.add(name, name, z.object({}), async () => {
      calls++;
      return 'result';
    });
  assert.deepEqual(
    tools.definitions().map((tool) => tool.name),
    ['image_search'],
  );
  await assert.rejects(tools.call('url_read', {}, context), /not permitted/);
  assert.equal(calls, 0);

  context.aiModel = 'gpt-4.1';
  const older = new Tools(
    { async audit() {} },
    async (name, current) => modelAllowsApplicationTool(current.aiModel, name),
    (name) => modelAllowsApplicationTool(context.aiModel, name),
  );
  older.add('url_read', 'Read web', z.object({}), async () => {
    calls++;
    return 'result';
  });
  assert.deepEqual(
    older.definitions().map((tool) => tool.name),
    ['url_read'],
  );
  context.aiModel = 'gpt-5.1';
  await assert.rejects(older.call('url_read', {}, context), /not permitted/);
  assert.equal(calls, 0);
});
