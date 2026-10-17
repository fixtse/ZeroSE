import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { VoiceBridge, voiceToken } from '../src/application/voice-bridge.js';
import { Assistant } from '../src/application/assistant.js';
import { fixture, until } from './helpers.js';

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
