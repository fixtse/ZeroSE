import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { fixture } from './helpers.js';
import { PostgresZeroSettings } from '../src/adapters/outbound/postgres-zero-settings.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { voiceToken } from '../src/application/voice-bridge.js';
import { registerHomeAssistantControl } from '../src/adapters/inbound/ha-control-tools.js';
import { Tools } from '../src/application/tool-registry.js';
import type { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';

test('one authoritative prompt persists, rejects stale edits and isolates management credentials', async () => {
  const f = await fixture();
  const settings = new PostgresZeroSettings(f.store.db);
  await settings.initialize('Original owner prompt');
  const server = createHttpServer(
    f.config,
    f.store,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    settings,
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/integrations/home-assistant/settings`;
  const token = createHmac('sha256', f.config.apiKey)
    .update('assistant-home-assistant-settings-v1')
    .digest('hex');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    for (const credential of [f.config.apiKey, voiceToken(f.config.apiKey), '']) {
      assert.equal(
        (await fetch(url, { headers: { Authorization: `Bearer ${credential}` } })).status,
        401,
      );
    }
    const current = await (await fetch(url, { headers })).json();
    const value = { ...current, prompt: 'Updated for Telegram and Assist' };
    assert.equal(
      (await fetch(url, { method: 'PUT', headers, body: JSON.stringify(value) })).status,
      200,
    );
    assert.equal(
      (await fetch(url, { method: 'PUT', headers, body: JSON.stringify(current) })).status,
      409,
    );
    await settings.initialize('Old file must never override a saved edit');
    assert.equal((await settings.read()).prompt, value.prompt);
    assert.equal(
      (
        await fetch(url, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ ...value, revision: 2, services: ['*'] }),
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('service access is checked on every invocation, including existing tool registries', async () => {
  const f = await fixture();
  const settings = new PostgresZeroSettings(f.store.db);
  await settings.initialize('Zero');
  let calls = 0;
  const ha = {
    async callService() {
      calls++;
      return { ok: true };
    },
    async services() {
      return [
        { domain: 'frigate', services: { restart: { fields: {} } } },
        { domain: 'conversation', services: { process: { fields: {} } } },
      ];
    },
  } as unknown as HomeAssistant;
  const tools = new Tools(f.store);
  registerHomeAssistantControl(tools, ha, settings);
  const context = {
    jobId: 'settings-test',
    session: 'telegram:owner',
    signal: new AbortController().signal,
  };
  const invoke = (service: string, data = {}) =>
    tools.call('ha_service_call', { service, data }, context);
  try {
    await assert.rejects(invoke('frigate.restart'), /not allowed/);
    await settings.update({
      ...(await settings.read()),
      services: ['frigate.restart'],
      frigate: true,
      assist: true,
    });
    await invoke('frigate.restart');
    const discovered = await tools.call('ha_services', {}, context);
    assert.match(JSON.stringify(discovered), /conversation.process/);
    await invoke('conversation.process', { agent_id: 'homeassistant' });
    await assert.rejects(
      invoke('conversation.process', { agent_id: 'conversation.zero' }),
      /separate/,
    );
    await settings.update({ ...(await settings.read()), assist: false });
    await assert.rejects(
      invoke('conversation.process', { agent_id: 'homeassistant' }),
      /not allowed/,
    );
    await settings.update({ ...(await settings.read()), assist: true });
    await settings.update({ ...(await settings.read()), frigate: false });
    await assert.rejects(invoke('frigate.restart'), /not allowed/);
    await settings.update({ ...(await settings.read()), homeAssistant: false });
    await assert.rejects(
      invoke('conversation.process', { agent_id: 'homeassistant' }),
      /not allowed/,
    );
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});

test('the next Telegram or Assist owner turn reads the updated prompt without restarting', async () => {
  const f = await fixture();
  const settings = new PostgresZeroSettings(f.store.db);
  await settings.initialize('First identity');
  const { ProcessManagedMessage } = await import(
    '../src/application/use-cases/process-managed-message.js'
  );
  const prompts: string[] = [];
  const agent = {
    async run(_session: string, _input: string, instructions: string) {
      prompts.push(instructions);
      return 'Reply';
    },
  };
  const google = {
    enabled: false,
    async context() {
      return '';
    },
    async events() {
      return [];
    },
    async tasks() {
      return [];
    },
    async cleanTasks() {
      return { deleted: 0 };
    },
  };
  const telegram = {
    async input() {
      return { text: 'Hello', images: [], transcriptionOnly: false };
    },
    async send() {},
    async sendImage() {},
    async sendVoice() {},
    async typing() {},
  };
  const managed = new ProcessManagedMessage(
    f.store,
    agent,
    async () => ({ config: f.config, google }),
    async () => telegram,
    async () => true,
    async () => (await settings.read()).prompt,
  );
  try {
    const base = {
      id: 'prompt-test',
      session: 'telegram:1234',
      status: 'running' as const,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    const context = {
      jobId: 'prompt-test',
      session: base.session,
      signal: new AbortController().signal,
    };
    await managed.execute(
      { ...base, payload: { kind: 'telegram', message: { text: 'Hello' } } } as any,
      context,
    );
    await settings.update({ ...(await settings.read()), prompt: 'Second identity from HA' });
    await managed.execute(
      { ...base, payload: { kind: 'chat', text: 'Hello', source: 'home_assistant_voice' } } as any,
      context,
    );
    assert.match(prompts[0]!, /First identity/);
    assert.match(prompts[1]!, /Second identity from HA/);
    assert.doesNotMatch(prompts[1]!, /First identity/);
  } finally {
    await f.close();
  }
});
