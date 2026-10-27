import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiModelCatalog } from '../src/adapters/outbound/ai-model-catalog.js';
import { AIAdmin } from '../src/adapters/inbound/ai-admin.js';
import type { AIProvider, AISettingsPort } from '../src/domain/ai.js';

const provider: AIProvider = {
  id: 'connection',
  name: 'Test',
  kind: 'openai',
  baseUrl: '',
  apiKey: 'private-test-key',
};
const query = { search: '', offset: 0, limit: 20 };
const unused = async (): Promise<never> => {
  throw new Error('Unexpected backend');
};

test('HTTP catalogs use provider credentials, filter, deduplicate and paginate without leaking secrets', async () => {
  for (const kind of ['openai', 'openrouter', 'compatible', 'ollama', 'anthropic'] as const) {
    const catalog = aiModelCatalog(unused, unused, async (url, init) => {
      assert.match(String(url), /\/v1\/models|\/api\/v1\/models/);
      const headers = init!.headers as Record<string, string>;
      assert.equal(
        kind === 'anthropic' ? headers['x-api-key'] : headers.Authorization,
        kind === 'anthropic' ? provider.apiKey : 'Bearer ' + provider.apiKey,
      );
      assert.equal(init!.redirect, 'error');
      return Response.json({
        data: [{ id: 'b', display_name: 'Beta' }, { id: 'a', name: 'Alpha' }, { id: 'a' }],
      });
    });
    const page = await catalog(
      {
        ...provider,
        kind,
        ...(kind === 'compatible' ? { baseUrl: 'https://example.com/v1' } : {}),
      },
      { search: 'a', offset: 1, limit: 1 },
      AbortSignal.timeout(5000),
    );
    assert.equal(page.total, 2);
    assert.equal(page.items[0].id, 'b');
    assert(!JSON.stringify(page).includes(provider.apiKey));
  }
});

test('Codex reads all catalog pages and HA delegates scoped discovery', async () => {
  const cursors: (string | null)[] = [];
  const catalog = aiModelCatalog(
    async (cursor) => {
      cursors.push(cursor);
      return {
        data: [
          {
            id: 'rpc-id',
            model: cursor ? 'second' : 'first',
            displayName: cursor ? 'Second' : 'First',
          },
        ],
        nextCursor: cursor ? null : 'next',
      };
    },
    async (_provider, requested) => ({
      items: [{ id: 'ai_task.test', name: requested.search }],
      total: 1,
    }),
  );
  assert.equal(
    (await catalog({ ...provider, kind: 'codex' }, query, AbortSignal.timeout(5000))).total,
    2,
  );
  assert.deepEqual(cursors, [null, 'next']);
  assert.equal(
    (
      await catalog(
        { ...provider, kind: 'home_assistant' },
        { ...query, search: 'Task' },
        AbortSignal.timeout(5000),
      )
    ).items[0].name,
    'Task',
  );
});

test('Anthropic follows pagination and provider errors are redacted and not retried', async () => {
  let calls = 0;
  const catalog = aiModelCatalog(unused, unused, async (url) => {
    calls++;
    return Response.json(
      calls === 1
        ? { data: [{ id: 'first' }], has_more: true, last_id: 'first' }
        : {
            data: [{ id: new URL(String(url)).searchParams.get('after_id') + '-next' }],
            has_more: false,
          },
    );
  });
  assert.equal(
    (await catalog({ ...provider, kind: 'anthropic' }, query, AbortSignal.timeout(5000))).total,
    2,
  );
  assert.equal(calls, 2);
  calls = 0;
  const failed = aiModelCatalog(unused, unused, async () => {
    calls++;
    return new Response(provider.apiKey, { status: 401 });
  });
  await assert.rejects(
    failed(provider, query, AbortSignal.timeout(5000)),
    (error) =>
      error instanceof Error &&
      /401/.test(error.message) &&
      !error.message.includes(provider.apiKey),
  );
  assert.equal(calls, 1);
});

test('admin discovery reuses saved keys only for the same connection and never writes settings', async () => {
  const repository = {
    read: async () => ({ providers: [provider] }),
    update: unused,
  } as unknown as AISettingsPort;
  const keys: string[] = [];
  const admin = new AIAdmin(repository, undefined, async (connection, requested) => {
    keys.push(connection.apiKey);
    assert.equal(requested.limit, 10);
    return { items: [{ id: 'available', name: 'Available' }], total: 1 };
  });
  for (const patch of [
    {},
    { baseUrl: 'https://different.example/v1' },
    { clearApiKey: true },
    { apiKey: 'replacement' },
  ]) {
    let status = 0;
    await admin.handle(
      { method: 'POST' } as any,
      '/v1/admin/ai/models',
      async () => ({ provider: { ...provider, apiKey: '', ...patch }, limit: 10 }),
      (s) => {
        status = s;
      },
    );
    assert.equal(status, 200);
  }
  assert.deepEqual(keys, [provider.apiKey, '', '', 'replacement']);
  await assert.rejects(
    admin.handle(
      { method: 'POST' } as any,
      '/v1/admin/ai/models',
      async () => ({ provider, limit: 51 }),
      () => {},
    ),
  );
});
