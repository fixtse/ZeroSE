import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fixture } from './helpers.js';
import { AssistantDefinitions } from '../src/application/assistant-definitions.js';
import { PostgresAssistantDefinitions } from '../src/adapters/outbound/postgres-assistant-definitions.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresZeroSettings } from '../src/adapters/outbound/postgres-zero-settings.js';
import { salemPrompt } from '../src/application/prompts.js';
import { ProcessManagedMessage } from '../src/application/use-cases/process-managed-message.js';
import type { AgentPort, GooglePort, TelegramPort } from '../src/application/ports.js';
import { AssistantAdmin } from '../src/adapters/inbound/assistant-admin.js';
import { SetupAdmin } from '../src/adapters/inbound/setup-admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { Access } from '../src/application/access.js';
import type { IntegrationAccess } from '../src/application/integration-access.js';
import type { HomeAssistantPairing } from '../src/application/home-assistant-pairing.js';
async function setup() {
  const f = await fixture();
  f.config.telegram.allowedUsers = ['1', '2'];
  const profiles = new PostgresAccess(f.store.pool, f.config.apiKey);
  await profiles.initialize(f.config);
  const settings = new PostgresZeroSettings(f.store.pool);
  await settings.initialize('PRIVATE OWNER PROMPT');
  const repository = new PostgresAssistantDefinitions(f.store.pool);
  const definitions = new AssistantDefinitions(repository, randomUUID);
  return { ...f, profiles, settings, repository, definitions };
}

test('catalog imports Salem once, preserves legacy defaults and keeps summaries prompt-free and paginated', async () => {
  const f = await setup();
  try {
    assert.equal((await f.definitions.get('salem'))?.prompt, salemPrompt);
    const owner = await f.profiles.profile('zero', '1'),
      user = await f.profiles.profile('zero', '2');
    assert.equal((await f.definitions.resolve(owner, 'zero')).id, 'zero');
    assert.equal((await f.definitions.resolve(user, 'zero')).id, 'standard');
    await f.profiles.discover('salem', '3', 'Salem user', 'user');
    assert.equal(
      (await f.definitions.resolve(await f.profiles.profile('salem', '3'), 'salem')).id,
      'salem',
    );
    assert.equal(
      (await f.definitions.resolve({ ...user!, promptPreset: 'salem' }, 'zero')).id,
      'salem',
    );
    assert.equal(
      (await f.definitions.resolve({ ...user!, bot: 'salem', promptPreset: 'standard' }, 'salem'))
        .id,
      'standard',
    );
    const saved = await f.definitions.update('salem', {
      name: 'Salem',
      prompt: 'Edited Salem prompt',
      revision: 1,
    });
    assert.equal(saved?.revision, 2);
    await f.profiles.initialize(f.config);
    assert.equal((await f.definitions.get('salem'))?.prompt, 'Edited Salem prompt');
    for (let i = 0; i < 23; i++)
      await f.definitions.create({
        name: 'Research ' + String(i).padStart(2, '0'),
        prompt: 'Research private instructions ' + i,
      });
    const first = await f.definitions.list('Research', 0, 20),
      last = await f.definitions.list('Research', 20, 20);
    assert.equal(first.total, 23);
    assert.equal(first.items.length, 20);
    assert.equal(last.items.length, 3);
    assert.equal('prompt' in first.items[0], false);
    assert.equal(JSON.stringify(first).includes('private instructions'), false);
    assert.equal(new Set([...first.items, ...last.items].map((item) => item.id)).size, 23);
  } finally {
    await f.close();
  }
});

test('Zero edits use the same authoritative settings revision and reject stale writes in both directions', async () => {
  const f = await setup();
  try {
    const zero = (await f.definitions.get('zero'))!;
    const saved = await f.definitions.update('zero', {
      name: 'Zero',
      prompt: 'New shared identity',
      revision: zero.revision,
    });
    assert.equal(saved?.prompt, 'New shared identity');
    assert.equal((await f.settings.read()).prompt, 'New shared identity');
    assert.equal(
      await f.definitions.update('zero', {
        name: 'Zero',
        prompt: 'Stale editor',
        revision: zero.revision,
      }),
      undefined,
    );
    const settings = await f.settings.read();
    await f.settings.update({ ...settings, prompt: 'Changed in HA', assist: true });
    assert.equal((await f.definitions.get('zero'))?.prompt, 'Changed in HA');
    assert.equal(
      await f.definitions.update('zero', {
        name: 'Zero',
        prompt: 'Stale after HA',
        revision: saved!.revision,
      }),
      undefined,
    );
    assert.equal((await f.settings.read()).assist, true);
  } finally {
    await f.close();
  }
});

test('assignments preserve credentials, permissions and sessions; in-use definitions cannot be deleted', async () => {
  const f = await setup();
  try {
    const custom = await f.definitions.create({ name: 'Planner', prompt: 'Plan carefully.' });
    const before = (await f.profiles.profile('zero', '2'))!;
    await f.store.addMessage('telegram:2', 'user', 'Keep this history');
    assert.equal(await f.definitions.assign('zero', '2', custom.id), true);
    const after = (await f.profiles.profile('zero', '2'))!;
    assert.deepEqual({ ...after, assistantId: undefined }, { ...before, assistantId: undefined });
    assert.equal((await f.store.history('telegram:2')).length, 1);
    assert.equal(await f.definitions.remove(custom.id, 1), 'conflict');
    assert.equal(await f.definitions.assign('zero', '2', 'not-found'), false);
    await f.profiles.saveProfile({ ...after, label: 'Updated label' });
    assert.equal((await f.profiles.profile('zero', '2'))?.assistantId, custom.id);
    await f.definitions.assign('zero', '2', 'standard');
    assert.equal(await f.definitions.remove(custom.id, 2), 'conflict');
    assert.equal(await f.definitions.remove(custom.id, 1), 'deleted');
    assert.equal(await f.definitions.remove('salem', 1), 'conflict');
    assert.equal(await f.definitions.remove('zero', 1), 'conflict');
    await f.profiles.saveProfile({
      bot: 'salem',
      chatId: '-5',
      kind: 'group',
      label: 'Group',
      enabled: true,
      owner: false,
      capabilities: ['web'],
      assistantId: 'salem',
    });
    await f.profiles.migrateGroup('salem', '-5', '-6');
    assert.equal((await f.profiles.profile('salem', '-6'))?.assistantId, 'salem');
  } finally {
    await f.close();
  }
});

test('next Telegram and HA turns resolve only the assigned prompt without resetting history or granting tools', async () => {
  const f = await setup();
  try {
    const custom = await f.definitions.create({
      name: 'Planner',
      prompt: 'Planner instructions for {{name}} in {{timezone}}. Identity {{identity}}.',
    });
    await f.definitions.assign('zero', '2', custom.id);
    const prompts: string[] = [],
      sessions: string[] = [];
    const agent: AgentPort = {
      async run(session, _input, instructions) {
        sessions.push(session);
        prompts.push(instructions);
        return 'Reply';
      },
    };
    const google = { enabled: false } as GooglePort,
      telegram = {} as TelegramPort;
    const managed = new ProcessManagedMessage(
      f.store,
      agent,
      async () => ({ config: f.config, google, profile: await f.profiles.profile('zero', '2') }),
      async () => telegram,
      async () => true,
      'PRIVATE OWNER PROMPT',
      f.definitions,
    );
    const context = () => ({
      session: 'telegram:2',
      jobId: randomUUID(),
      signal: new AbortController().signal,
    });
    await managed.execute(
      {
        id: randomUUID(),
        session: 'telegram:2',
        status: 'running',
        payload: { kind: 'chat', name: 'Alex', text: 'Hello' },
      },
      context(),
    );
    assert.match(prompts[0], /Planner instructions for Alex in Europe\/Madrid/);
    assert.match(prompts[0], /Identity Planner/);
    assert.equal(prompts[0].includes('PRIVATE OWNER PROMPT'), false);
    assert.equal(prompts[0].includes('hechicero convertido'), false);
    const edited = await f.definitions.update(custom.id, {
      name: 'Planner',
      prompt: 'Revised instructions',
      revision: 1,
    });
    assert.equal(edited?.revision, 2);
    await managed.execute(
      {
        id: randomUUID(),
        session: 'telegram:2',
        status: 'running',
        payload: { kind: 'chat', text: 'Hello from HA', source: 'home_assistant_voice' },
      },
      context(),
    );
    assert.match(prompts[1], /^Revised instructions/);
    assert.deepEqual(sessions, ['telegram:2', 'telegram:2']);
    assert.equal((await f.store.history('telegram:2')).length, 4);
    assert.deepEqual((await f.profiles.profile('zero', '2'))?.capabilities, [
      'web',
      'transcription',
    ]);
    await f.definitions.assign('zero', '2', 'salem');
    await managed.execute(
      {
        id: randomUUID(),
        session: 'telegram:2',
        status: 'running',
        payload: { kind: 'chat', text: 'Hi' },
      },
      context(),
    );
    assert.match(prompts[2], /Eres Salem, el hechicero/);
    assert.match(prompts[2], /Use memory_save only/);
  } finally {
    await f.close();
  }
});

test('assistant API validates inputs and requires administrator authorization for catalog, prompt and assignment', async () => {
  const f = await setup();
  const access = new Access(f.profiles, f.store);
  const setupAdmin = new SetupAdmin(
    {} as IntegrationAccess,
    {} as HomeAssistantPairing,
    f.settings,
    f.profiles,
    'https://zero.example',
    new AssistantAdmin(f.definitions, f.profiles),
  );
  const server = createHttpServer(
    f.config,
    f.store,
    undefined,
    { access, admin: new Admin(f.config, f.profiles, async () => {}) },
    undefined,
    undefined,
    undefined,
    f.settings,
    undefined,
    undefined,
    setupAdmin,
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, method = 'GET', body?: unknown, authorized = true) =>
    fetch(url + '/v1/admin/setup/' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { Authorization: 'Bearer ' + f.config.apiKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await request('assistants', 'GET', undefined, false)).status, 401);
    assert.equal(
      (await request('assistants/salem', 'PUT', { name: 'x', prompt: 'x', revision: 1 }, false))
        .status,
      401,
    );
    assert.equal((await request('assistants?limit=1000')).status, 400);
    assert.equal((await request('assistants', 'POST', { name: ' ', prompt: 'x' })).status, 400);
    const response = await request('assistants', 'POST', {
      name: 'Tutor',
      prompt: 'Tutor private prompt',
    });
    assert.equal(response.status, 201);
    const value = (await response.json()) as { id: string; revision: number };
    const summary = await (await request('assistants?search=Tutor')).json();
    assert.equal(JSON.stringify(summary).includes('Tutor private prompt'), false);
    assert.equal(
      (await request('profiles/zero/2/assistant', 'PUT', { assistantId: value.id }, false)).status,
      401,
    );
    assert.equal(
      (await request('profiles/zero/2/assistant', 'PUT', { assistantId: value.id })).status,
      200,
    );
    const assigned = await (await request('profiles/zero/2/assistant')).json();
    assert.equal(assigned.name, 'Tutor');
    assert.equal('prompt' in assigned, false);
    assert.equal((await request('assistants/' + value.id, 'DELETE', { revision: 1 })).status, 409);
    assert.equal(
      (
        await request('assistants/' + value.id, 'PUT', {
          name: 'Tutor',
          prompt: 'New instructions',
          revision: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request('assistants/' + value.id, 'PUT', {
          name: 'Tutor',
          prompt: 'Stale',
          revision: 1,
        })
      ).status,
      409,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
