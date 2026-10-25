import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import {
  VoiceBridge,
  voiceToken,
  voiceOwnerSession,
  voiceUserSession,
} from '../src/application/voice-bridge.js';
import { Assistant } from '../src/application/assistant.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresZeroSettings } from '../src/adapters/outbound/postgres-zero-settings.js';
import { Access } from '../src/application/access.js';
import { fixture, until } from './helpers.js';

test('voice owner uses configured Zero availability without requiring a managed-bot record', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  f.config.telegram.allowedUsers = ['1234'];
  await repository.initialize(f.config);
  const access = new Access(repository, f.store);
  let enabled = true;
  const bots = {
    async isEnabled(bot: string) {
      assert.equal(bot, 'zero');
      return enabled;
    },
  };
  try {
    assert.equal(
      (await repository.bots()).some((bot) => bot.id === 'zero'),
      false,
    );
    assert.equal(await voiceOwnerSession('1234', access, bots), 'telegram:1234');
    assert.equal(await voiceOwnerSession('other', access, bots), undefined);
    assert.equal(await voiceOwnerSession(undefined, access, bots), undefined);
    enabled = false;
    assert.equal(await voiceOwnerSession('1234', access, bots), undefined);
  } finally {
    await f.close();
  }
});

test('voice bridge scopes credentials, owner session and jobs; duplicate requests never replay', async () => {
  const f = await fixture();
  const satellite = 'assist_satellite.test_voice';
  let enabled = true,
    calls = 0,
    deliveries = 0;
  const voice = new VoiceBridge(f.store, satellite, async () =>
    enabled ? 'telegram:owner' : undefined,
  );
  const server = createHttpServer(
    f.config,
    f.store,
    undefined,
    undefined,
    undefined,
    undefined,
    voice,
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = {
    Authorization: `Bearer ${voiceToken(f.config.apiKey)}`,
    'Content-Type': 'application/json',
  };
  const input = { request_id: randomUUID(), satellite_id: satellite, text: 'Voice question' };
  const submit = (value = input, authorization = headers.Authorization) =>
    fetch(base + '/v1/voice/turns', {
      method: 'POST',
      headers: { ...headers, Authorization: authorization },
      body: JSON.stringify(value),
    });
  const worker = new Assistant(
    f.config,
    f.store,
    {
      chat: async (job) => {
        if (job.payload.source === 'home_assistant_voice') calls++;
        assert.equal(job.session, 'telegram:owner');
        return { output: 'Spoken reply' };
      },
    },
    { async cleanup() {} },
    {
      async send() {
        deliveries++;
      },
      async sendImage() {
        deliveries++;
      },
      async sendVoice() {
        deliveries++;
      },
      async typing() {
        deliveries++;
      },
      async input() {
        throw new Error('unused');
      },
    },
  );
  try {
    assert.equal((await submit(input, `Bearer ${f.config.apiKey}`)).status, 401);
    assert.equal((await submit({ ...input, satellite_id: 'assist_satellite.other' })).status, 403);
    assert.equal((await submit({ ...input, text: '' })).status, 400);
    const first = (await (await submit()).json()) as any;
    const duplicate = (await (await submit()).json()) as any;
    assert.equal(first.jobId, duplicate.jobId);
    const telegram = await f.store.enqueue('telegram:owner', {
      kind: 'chat',
      text: 'Earlier message',
    });
    assert.equal((await fetch(base + '/v1/voice/turns/' + telegram.id, { headers })).status, 404);
    assert.equal((await fetch(base + '/v1/jobs/' + first.jobId, { headers })).status, 401);
    worker.start();
    await until(async () => (await f.store.job(first.jobId))?.status === 'done');
    const result = (await (
      await fetch(base + '/v1/voice/turns/' + first.jobId, { headers })
    ).json()) as any;
    assert.equal(result.output, 'Spoken reply');
    assert.equal(((await (await submit()).json()) as any).jobId, first.jobId);
    assert.equal(deliveries, 0);
    assert.equal(calls, 1);
    enabled = false;
    assert.equal((await submit({ ...input, request_id: randomUUID() })).status, 403);
    assert.equal((await fetch(base + '/v1/voice/turns/' + first.jobId, { headers })).status, 404);
  } finally {
    await worker.close();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await f.close();
  }
});

test('HA user bindings route Android requests to private Zero sessions and isolate results', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  f.config.telegram.allowedUsers = ['1234'];
  await repository.initialize(f.config);
  const owner = (await repository.profile('zero', '1234'))!;
  await repository.saveProfile({ ...owner, chatId: '5678', owner: false, label: 'Second user' });
  await repository.saveProfile({ ...owner, chatId: '-999', kind: 'group', owner: false });
  const access = new Access(repository, f.store);
  const settings = new PostgresZeroSettings(f.store.pool);
  await settings.initialize('Zero');
  let enabled = true;
  const bots = {
    async isEnabled() {
      return enabled;
    },
  };
  const voice = new VoiceBridge(
    f.store,
    'assist_satellite.test',
    async () => 'telegram:1234',
    (id) => voiceUserSession(id, settings, access, bots),
  );
  const server = createHttpServer(
    f.config,
    f.store,
    undefined,
    { access, admin: {} as any },
    undefined,
    undefined,
    voice,
    settings,
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const user = 'a'.repeat(32),
    other = 'b'.repeat(32);
  const voiceHeaders = {
    Authorization: `Bearer ${voiceToken(f.config.apiKey)}`,
    'Content-Type': 'application/json',
  };
  const { createHmac } = await import('node:crypto');
  const settingsHeaders = {
    ...voiceHeaders,
    Authorization:
      'Bearer ' +
      createHmac('sha256', f.config.apiKey)
        .update('assistant-home-assistant-settings-v1')
        .digest('hex'),
  };
  const bind = async (
    userId: string,
    chatId: string | null,
    revision?: number,
    headers = settingsHeaders,
  ) =>
    fetch(base + '/v1/integrations/home-assistant/settings/users', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        revision: revision ?? (await settings.read()).revision,
        userId,
        chatId,
      }),
    });
  const input = { request_id: randomUUID(), ha_user_id: user, text: 'Who am I?' };
  const submit = (value = input) =>
    fetch(base + '/v1/voice/turns', {
      method: 'POST',
      headers: voiceHeaders,
      body: JSON.stringify(value),
    });
  const result = (id: string, userId?: string) =>
    fetch(base + '/v1/voice/turns/' + id + (userId ? '?ha_user_id=' + userId : ''), {
      headers: voiceHeaders,
    });
  try {
    assert.equal((await submit()).status, 403);
    assert.equal((await bind(user, '5678', undefined, voiceHeaders)).status, 401);
    assert.equal((await bind(user, '99999')).status, 400);
    assert.equal((await bind(user, '-999')).status, 400);
    assert.equal((await bind(user, '5678')).status, 200);
    assert.equal((await bind(other, '1234', 1)).status, 409);
    assert.equal((await bind(other, '1234')).status, 200);
    const accepted = await submit();
    assert.equal(accepted.status, 202);
    const job = (await accepted.json()) as any;
    assert.equal((await f.store.job(job.jobId))?.session, 'telegram:5678');
    assert.equal(((await (await submit()).json()) as any).jobId, job.jobId);
    assert.equal((await result(job.jobId, user)).status, 200);
    assert.equal((await result(job.jobId, other)).status, 404);
    assert.equal((await result(job.jobId)).status, 404);
    // Sharing a Zero account still does not grant access to another HA user's job.
    assert.equal((await bind(other, '5678')).status, 200);
    assert.equal((await result(job.jobId, other)).status, 404);
    // Older settings clients cannot erase bindings when editing the prompt.
    const current = await settings.read();
    const { homeAssistantUsers, ...oldClient } = current;
    assert.equal(
      (
        await fetch(base + '/v1/integrations/home-assistant/settings', {
          method: 'PUT',
          headers: settingsHeaders,
          body: JSON.stringify({ ...oldClient, prompt: 'Updated' }),
        })
      ).status,
      200,
    );
    assert.deepEqual((await settings.read()).homeAssistantUsers, homeAssistantUsers);
    enabled = false;
    assert.equal((await submit()).status, 403);
    assert.equal((await result(job.jobId, user)).status, 404);
    enabled = true;
    await repository.saveProfile({ ...owner, chatId: '5678', owner: false, enabled: false });
    assert.equal((await submit()).status, 403);
    assert.equal((await bind(user, '5678')).status, 400);
    await repository.saveProfile({ ...owner, chatId: '5678', owner: false });
    assert.equal((await bind(user, null)).status, 200);
    assert.equal((await submit()).status, 403);
    assert.equal((await result(job.jobId, user)).status, 404);
    assert.equal((await bind(user, '1234')).status, 200);
    assert.equal((await result(job.jobId, user)).status, 404);
    assert.equal((await submit({ ...input, request_id: randomUUID() })).status, 202);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
