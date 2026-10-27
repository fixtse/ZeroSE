import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AIAgent } from '../src/application/ai-agent.js';
import { HttpAIAgent } from '../src/adapters/outbound/http-ai-agent.js';
import { PostgresAI } from '../src/adapters/outbound/postgres-ai.js';
import { AIAdmin } from '../src/adapters/inbound/ai-admin.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { Tools } from '../src/application/tool-registry.js';
import type { AISettings, AISettingsPort } from '../src/domain/ai.js';
import type { AccessProfile } from '../src/domain/access.js';
import type { AgentPort } from '../src/application/ports.js';
import { fixture } from './helpers.js';
const settings = (): AISettings => ({
  revision: 1,
  defaultModel: 'main',
  providers: [
    { id: 'cli', name: 'CLI', kind: 'codex', apiKey: '', baseUrl: '' },
    { id: 'api', name: 'API', kind: 'openai', apiKey: 'private-key', baseUrl: '' },
  ],
  models: [
    { id: 'main', label: 'Main', model: 'cli-model', provider: 'cli', effort: 'high' },
    { id: 'alt', label: 'Alternate', model: 'api-model', provider: 'api' },
  ],
});
const context = (userQuestion = true) => ({
  session: 'telegram:1',
  jobId: 'test',
  signal: AbortSignal.timeout(5000),
  userQuestion,
});
test('selection is one question only, admin-approved, isolated and rechecked; background turns do not consume it', async () => {
  const value = settings();
  const selections = new Map<string, string>();
  const repository: AISettingsPort = {
    read: async () => value,
    update: async () => true,
    selectNext: async (session, model) => {
      if (model) selections.set(session, model);
      else selections.delete(session);
    },
    consumeNext: async (session) => {
      const model = selections.get(session);
      selections.delete(session);
      return model;
    },
  };
  const profile: AccessProfile = {
    bot: 'zero',
    chatId: '1',
    label: 'User',
    kind: 'user',
    enabled: true,
    capabilities: [],
    owner: false,
    alternateModels: ['alt'],
  };
  const cli: AgentPort = {
    run: async (...args) => {
      assert.equal(args[3].aiEffort, 'high');
      return 'cli:' + args[3].aiModel;
    },
  };
  const agent = new AIAgent(
    repository,
    async (session) => (session === 'telegram:1' ? profile : undefined),
    cli,
    () => ({ run: async () => 'remote' }),
  );
  const run = (session = 'telegram:1', user = true) =>
    agent.run(session, 'question', 'instructions', { ...context(user), session });
  assert.match((await agent.userCommand('telegram:2', '/model alt'))!, /no permitido/);
  assert.match((await agent.userCommand('telegram:1', '/model'))!, /\/model #1/);
  assert.equal(await run(), 'cli:cli-model');
  await agent.userCommand('telegram:1', '/model@zero_bot #1');
  assert.equal(await run('telegram:2'), 'cli:cli-model');
  assert.equal(await run('telegram:1', false), 'cli:cli-model');
  assert.equal(await run(), 'remote');
  assert.equal(await run(), 'cli:cli-model');
  profile.defaultModel = 'alt';
  assert.equal(await run(), 'remote');
  await agent.userCommand('telegram:1', '/model alt');
  await agent.userCommand('telegram:1', '/model default');
  assert.equal(selections.size, 0);
  await agent.userCommand('telegram:1', '/model alt');
  profile.alternateModels = [];
  await assert.rejects(run, /no longer permitted/);
  assert.equal(await agent.userCommand('telegram:1', 'hello'), undefined);
});
test('Postgres encrypts providers, protects revisions, persists profiles and atomically consumes overrides', async () => {
  const f = await fixture();
  try {
    const repository = new PostgresAI(f.store.db, f.config.apiKey);
    await repository.initialize('existing-codex');
    const initial = await repository.read();
    assert.equal(initial.models[0].model, 'existing-codex');
    assert.equal(await repository.update(settings()), true);
    assert.equal(await repository.update(settings()), false);
    const stored = (await f.store.pool.query('SELECT value FROM ai_settings')).rows[0].value;
    assert(!stored.includes('private-key'));
    assert.equal((await repository.read()).providers[1].apiKey, 'private-key');
    await repository.selectNext('one', 'alt');
    const results = await Promise.all([
      repository.consumeNext('one'),
      repository.consumeNext('one'),
    ]);
    assert.equal(results.filter((v) => v === 'alt').length, 1);
    const access = new PostgresAccess(f.store.db, f.config.apiKey);
    await access.initialize(f.config);
    await access.saveProfile({
      bot: 'zero',
      chatId: '1',
      kind: 'user',
      label: 'Test',
      enabled: true,
      owner: false,
      capabilities: [],
      defaultModel: 'alt',
      alternateModels: ['main'],
    });
    const profile = await access.profile('zero', '1');
    assert.equal(profile?.defaultModel, 'alt');
    assert.deepEqual(profile?.alternateModels, ['main']);
    const admin = new AIAdmin(repository);
    let status = 0,
      body: any;
    const send = (s: number, v: unknown) => {
      status = s;
      body = v;
    };
    await admin.handle({ method: 'GET' } as any, '/v1/admin/ai', async () => ({}), send);
    assert.equal(status, 200);
    assert.equal(body.providers[1].apiKey, '');
    assert.equal(body.providers[1].hasApiKey, true);
    assert.equal(body.providers[1].secretHint, '••••••••');
    assert.equal(body.codexAvailable, false);
    const availableAdmin = new AIAdmin(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => true,
    );
    await availableAdmin.handle({ method: 'GET' } as any, '/v1/admin/ai', async () => ({}), send);
    assert.equal(body.codexAvailable, true);
    const edit = {
      ...settings(),
      revision: 2,
      providers: settings().providers.map((p) => ({ ...p, apiKey: '' })),
    };
    await admin.handle({ method: 'PUT' } as any, '/v1/admin/ai', async () => edit, send);
    assert.equal(status, 200);
    assert.equal((await repository.read()).providers[1].apiKey, 'private-key');
    assert.equal((await repository.read()).models[0].effort, 'high');
    await admin.handle({ method: 'PUT' } as any, '/v1/admin/ai', async () => edit, send);
    assert.equal(status, 409);
    await assert.rejects(() => admin.validateModels('nonexistent'), /modelos disponibles/);
  } finally {
    await f.close();
  }
});
for (const kind of ['openai', 'anthropic', 'openrouter', 'compatible', 'ollama'] as const) {
  test(`${kind}: tools use application authorization, conversation is retained, failed HTTP requests are not retried`, async () => {
    const f = await fixture();
    try {
      const tools = new Tools(f.store);
      let writes = 0;
      tools.add('write', 'Write once', z.object({ value: z.string() }), async () => {
        writes++;
        return { saved: true };
      });
      await f.store.addMessage('telegram:1', 'assistant', 'previous provider answer');
      await f.store.setThread('telegram:1', 'old-codex-thread', 'old-policy');
      const requests: any[] = [];
      const responses = kind === 'openai',
        anthropic = kind === 'anthropic';
      const fake: typeof fetch = async (url, init) => {
        const body = JSON.parse(init!.body as string);
        requests.push(body);
        assert.match(
          String(url),
          responses ? /\/responses$/ : anthropic ? /\/messages$/ : /\/chat\/completions$/,
        );
        if (requests.length === 1)
          return Response.json(
            responses
              ? {
                  status: 'completed',
                  output: [
                    {
                      type: 'function_call',
                      call_id: 'call1',
                      name: 'write',
                      arguments: '{"value":"yes"}',
                    },
                  ],
                }
              : anthropic
                ? {
                    stop_reason: 'tool_use',
                    content: [
                      { type: 'tool_use', id: 'call1', name: 'write', input: { value: 'yes' } },
                    ],
                  }
                : {
                    choices: [
                      {
                        finish_reason: 'tool_calls',
                        message: {
                          role: 'assistant',
                          content: null,
                          tool_calls: [
                            {
                              id: 'call1',
                              type: 'function',
                              function: { name: 'write', arguments: '{"value":"yes"}' },
                            },
                          ],
                        },
                      },
                    ],
                  },
          );
        return Response.json(
          responses
            ? {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Done' }],
                  },
                ],
              }
            : anthropic
              ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] }
              : {
                  choices: [
                    { finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } },
                  ],
                },
        );
      };
      const provider = {
        id: 'api',
        name: 'API',
        kind,
        apiKey: 'secret',
        baseUrl: 'https://provider.test/v1',
      };
      const model = {
        ...settings().models[1],
        ...(kind !== 'anthropic' ? { effort: 'high' as const } : {}),
      };
      const agent = new HttpAIAgent(provider, model, f.store, async () => tools, fake);
      assert.equal(await agent.run('telegram:1', 'question', 'policy', context(false)), 'Done');
      assert.equal(writes, 1);
      for (const request of requests) {
        if (responses) assert.deepEqual(request.reasoning, { effort: 'high' });
        else assert.equal(request.reasoning_effort, anthropic ? undefined : 'high');
      }
      assert.match(JSON.stringify(requests[0]), /previous provider answer/);
      assert.match(JSON.stringify(requests[1]), /saved/);
      assert.equal(await f.store.threadPolicy('telegram:1'), 'ai-external');
      let failedRequests = 0;
      const failure = new HttpAIAgent(
        provider,
        model,
        f.store,
        async () => tools,
        async () => {
          failedRequests++;
          return new Response('private secret', { status: 429 });
        },
      );
      await assert.rejects(
        () => failure.run('telegram:1', 'question', 'policy', context()),
        /HTTP 429/,
      );
      assert.equal(failedRequests, 1);
    } finally {
      await f.close();
    }
  });
}
test('Codex changes model without losing history after another provider or model', async () => {
  const { Codex } = await import('../src/adapters/outbound/codex-app-server.js');
  const { resolve } = await import('node:path');
  const f = await fixture();
  f.config.codex.command = process.execPath;
  f.config.codex.args = [resolve('test/fake-app-server.mjs')];
  const codex = new Codex(f.config, f.store, new Tools(f.store));
  try {
    const inspect = async (model: string, aiEffort?: 'max') =>
      JSON.parse(
        await codex.run('telegram:1', 'inspect-tools', 'policy', {
          ...context(),
          aiModel: model,
          aiEffort,
        }),
      );
    assert.equal((await inspect('first')).settings.model, 'first');
    assert.equal((await inspect('first', 'max')).effort, 'max');
    assert.equal((await inspect('first')).effort, f.config.codex.effort);
    const first = await f.store.thread('telegram:1');
    assert.equal((await inspect('second')).settings.model, 'second');
    assert.notEqual(await f.store.thread('telegram:1'), first);
    const second = await f.store.thread('telegram:1');
    await f.store.setThread('telegram:1', second!, 'ai-external');
    assert.equal((await inspect('second')).settings.model, 'second');
    assert.notEqual(await f.store.thread('telegram:1'), second);
  } finally {
    codex.close();
    await f.close();
  }
});
test('background work uses the originating profile default, not the synthetic agent session', async () => {
  const repository = {
    read: async () => settings(),
    update: async () => true,
    selectNext: async () => {},
    consumeNext: async () => undefined,
  };
  const agent = new AIAgent(
    repository,
    async (session) =>
      session === 'telegram:1'
        ? {
            bot: 'zero',
            chatId: '1',
            label: 'User',
            kind: 'user',
            enabled: true,
            owner: false,
            capabilities: [],
            defaultModel: 'alt',
          }
        : undefined,
    { run: async () => 'cli' },
    () => ({ run: async () => 'profile-model' }),
  );
  assert.equal(
    await agent.run('system:memory:job1', 'summarize', 'policy', context(false)),
    'profile-model',
  );
});
test('Home Assistant AI reuses the scoped connection and executes only Zero tools without conversation recursion', async () => {
  const { HomeAssistantAI } = await import('../src/adapters/outbound/home-assistant-ai.js');
  const f = await fixture();
  try {
    const connection = {
      ...f.config.homeAssistant,
      url: 'https://ha.example',
      token: 'profile-secret',
    };
    const tools = new Tools(f.store, async (name) => name !== 'denied');
    let mutations = 0;
    tools.add('write', 'Write', z.object({ value: z.string() }), async () => {
      mutations++;
      return { saved: true };
    });
    tools.add('denied', 'Denied', z.object({}), async () => {
      throw new Error('Must not run');
    });
    await f.store.setThread('telegram:1', 'old-cli', 'policy');
    await f.store.addMessage('telegram:1', 'assistant', 'prior answer');
    const requests: any[] = [];
    const fake = async (url: string | URL, options: RequestInit = {}) => {
      assert.equal(
        String(url),
        'https://ha.example/api/services/ai_task/generate_data?return_response',
      );
      assert.equal((options.headers as any).Authorization, 'Bearer profile-secret');
      const body = JSON.parse(options.body as string);
      assert.equal(body.entity_id, 'ai_task.configured_model');
      assert.equal(body.conversation_id, undefined);
      assert.match(body.instructions, /Zero policy/);
      assert.match(body.instructions, /prior answer/);
      requests.push(body);
      const next =
        requests.length === 1
          ? { action: 'tool', name: 'denied', arguments: {} }
          : requests.length === 2
            ? { action: 'tool', name: 'write', arguments: { value: 'yes' } }
            : { action: 'final', text: 'Done' };
      return {
        service_response: { data: { result: JSON.stringify(next) }, conversation_id: 'not-reused' },
      };
    };
    const agent = new HomeAssistantAI(
      'ai_task.configured_model',
      f.store,
      async () => connection,
      async () => tools,
      fake,
    );
    assert.equal(await agent.run('telegram:1', 'question', 'Zero policy', context(false)), 'Done');
    assert.equal(mutations, 1);
    assert.match(requests[1].instructions, /not permitted/);
    assert.match(requests[2].instructions, /saved/);
    assert.equal(await f.store.threadPolicy('telegram:1'), 'ai-external');
    await assert.rejects(
      () => agent.run('telegram:1', 'image', 'policy', context(), ['/private/image.png']),
      /adjuntos locales/,
    );
    assert.equal(requests.length, 3);
    const unavailable = new HomeAssistantAI(
      'preferred',
      f.store,
      async () => f.config.homeAssistant,
      async () => tools,
      fake,
    );
    await assert.rejects(
      () => unavailable.run('telegram:1', 'question', 'policy', context()),
      /Configura y habilita/,
    );
    let attempts = 0;
    const preferred = new HomeAssistantAI(
      'preferred',
      f.store,
      async () => connection,
      async () => tools,
      async (_url, options) => {
        assert.equal(JSON.parse(options!.body as string).entity_id, undefined);
        attempts++;
        throw new Error('HA unavailable');
      },
    );
    await assert.rejects(
      () => preferred.run('telegram:1', 'question', 'policy', context()),
      /HA unavailable/,
    );
    assert.equal(attempts, 1);
    const noTools = new HomeAssistantAI(
      'preferred',
      f.store,
      async () => connection,
      async () => tools,
      async () => ({
        service_response: {
          data: {
            result: JSON.stringify({ action: 'tool', name: 'write', arguments: { value: 'x' } }),
          },
        },
      }),
    );
    await assert.rejects(
      () => noTools.run('telegram:1', 'summary', 'policy', context(false), [], {}, false),
      /tools disabled/,
    );
    assert.equal(mutations, 1);
  } finally {
    await f.close();
  }
});
test('Home Assistant AI catalog filters unsupported/unavailable entities and paginates on demand', async () => {
  const { HomeAssistantAI } = await import('../src/adapters/outbound/home-assistant-ai.js');
  const f = await fixture();
  try {
    const config = { ...f.config.homeAssistant, url: 'https://ha.test', token: 'secret' };
    const fake = async () => [
      {
        entity_id: 'ai_task.second',
        state: 'ready',
        attributes: { friendly_name: 'Second AI', supported_features: 1 },
      },
      {
        entity_id: 'ai_task.first',
        state: 'unknown',
        attributes: { friendly_name: 'First AI', supported_features: 3 },
      },
      { entity_id: 'conversation.zero', state: 'ready', attributes: { supported_features: 1 } },
      { entity_id: 'ai_task.image_only', state: 'ready', attributes: { supported_features: 4 } },
      { entity_id: 'ai_task.offline', state: 'unavailable', attributes: { supported_features: 1 } },
    ];
    const page = await HomeAssistantAI.catalog(
      config,
      { search: 'AI', offset: 1, limit: 1 },
      context().signal,
      fake,
    );
    assert.equal(page.total, 2);
    assert.deepEqual(page.items, [{ id: 'ai_task.second', name: 'Second AI' }]);
  } finally {
    await f.close();
  }
});

test('Codex availability checks the configured executable without starting a session', async () => {
  const { Codex } = await import('../src/adapters/outbound/codex-app-server.js');
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'zero-codex-availability-'));
  try {
    const command = join(directory, 'codex');
    const agent = new Codex(
      { ...f.config, codex: { ...f.config.codex, command } },
      f.store,
      new Tools(f.store),
    );
    assert.equal(await agent.available(), false);
    await writeFile(command, '#!/bin/sh\nexit 99\n', { mode: 0o600 });
    assert.equal(await agent.available(), false);
    await chmod(command, 0o700);
    assert.equal(await agent.available(), true);
    const directoryAgent = new Codex(
      { ...f.config, codex: { ...f.config.codex, command: directory } },
      f.store,
      new Tools(f.store),
    );
    assert.equal(await directoryAgent.available(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.close();
  }
});
