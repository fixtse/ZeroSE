import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { zeroSettings as settingsTable } from '../src/adapters/outbound/database-schema.js';
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

test('retired service permissions are ignored on read and removed on the next settings save', async () => {
  const f = await fixture();
  const settings = new PostgresZeroSettings(f.store.db);
  try {
    await settings.initialize('Existing prompt');
    const retired = JSON.stringify({
      assist: true,
      frigate: true,
      services: ['homeassistant.restart'],
    });
    await f.store.db
      .update(settingsTable)
      .set({ value: sql`${settingsTable.value} || ${retired}::jsonb` });
    const current = await settings.read();
    assert.deepEqual(current, { revision: 1, prompt: 'Existing prompt', homeAssistant: true });
    await settings.update({ ...current, prompt: 'Preserved settings' });
    const [row] = await f.store.db.select().from(settingsTable);
    assert.deepEqual(row!.value, { prompt: 'Preserved settings', homeAssistant: true });
  } finally {
    await f.close();
  }
});

test('control tools use Assist exposure commands and recheck the global switch on every invocation', async () => {
  const f = await fixture();
  const settings = new PostgresZeroSettings(f.store.db);
  await settings.initialize('Zero');
  const calls: Record<string, unknown>[] = [];
  const ha = {
    async assistCommand(command: Record<string, unknown>) {
      calls.push(command);
      if (command.type === 'assistant_zero/assist/call')
        return { accepted: true, service: command.service };
      return { items: [], total: 0, next_offset: null };
    },
  } as unknown as HomeAssistant;
  const tools = new Tools(f.store);
  registerHomeAssistantControl(tools, ha, settings);
  const context = {
    jobId: 'settings-test',
    session: 'telegram:owner',
    signal: new AbortController().signal,
  };
  try {
    await tools.call('ha_entities', { search: 'kitchen', offset: 2, limit: 5 }, context);
    await tools.call('ha_entity', { entity_id: 'light.kitchen' }, context);
    await tools.call('ha_services', { search: 'light.turn_on', limit: 1 }, context);
    await tools.call(
      'ha_service_call',
      { service: 'light.turn_on', data: { entity_id: 'light.kitchen' } },
      context,
    );
    assert.deepEqual(calls, [
      { type: 'assistant_zero/assist/entities', search: 'kitchen', offset: 2, limit: 5 },
      { type: 'assistant_zero/assist/entity', entity_id: 'light.kitchen' },
      { type: 'assistant_zero/assist/services', search: 'light.turn_on', offset: 0, limit: 1 },
      {
        type: 'assistant_zero/assist/call',
        service: 'light.turn_on',
        data: { entity_id: 'light.kitchen' },
      },
    ]);
    await settings.update({ ...(await settings.read()), homeAssistant: false });
    for (const [name, args] of [
      ['ha_entities', {}],
      ['ha_entity', { entity_id: 'light.kitchen' }],
      ['ha_services', {}],
      ['ha_service_call', { service: 'light.turn_on', data: { entity_id: 'light.kitchen' } }],
    ] as const)
      await assert.rejects(tools.call(name, args, context), /disabled/);
    assert.equal(calls.length, 4);
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
