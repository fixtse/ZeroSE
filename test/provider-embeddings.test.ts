import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  providerEmbeddings,
  providerEmbeddingCatalog,
} from '../src/adapters/outbound/provider-embeddings.js';
import { memoryEmbeddings } from '../src/adapters/outbound/memory-embeddings.js';
import { EmbeddingAdmin } from '../src/adapters/inbound/embedding-admin.js';
import { AIAdmin } from '../src/adapters/inbound/ai-admin.js';
import { ConfiguredEmbeddings } from '../src/application/configured-embeddings.js';
import type {
  AIProvider,
  AISettings,
  AISettingsPort,
  EmbeddingSettings,
} from '../src/domain/ai.js';

const settings: EmbeddingSettings = {
  mode: 'provider',
  provider: 'connection',
  model: 'embed-test',
  baseUrl: '',
  apiKey: '',
};
const provider: AIProvider = {
  id: 'connection',
  name: '',
  kind: 'openai',
  baseUrl: '',
  apiKey: 'private-provider-key',
};
const query = { search: '', offset: 0, limit: 20 };
const signal = () => AbortSignal.timeout(5000);

for (const kind of ['openai', 'openrouter', 'ollama', 'compatible'] as const) {
  test(`${kind} embeds queries and documents using existing credentials and pads smaller vectors`, async () => {
    const connection = {
      ...provider,
      kind,
      ...(kind === 'compatible' ? { baseUrl: 'https://compatible.invalid/custom/v1' } : {}),
    };
    let calls = 0;
    const port = providerEmbeddings(connection, settings, 4, async (url, init) => {
      calls++;
      assert.match(String(url), /\/embeddings$/);
      assert.equal(
        (init!.headers as Record<string, string>).Authorization,
        'Bearer ' + provider.apiKey,
      );
      assert.equal(init!.redirect, 'error');
      const body = JSON.parse(init!.body as string);
      assert.equal(body.model, settings.model);
      assert.equal(body.encoding_format, 'float');
      assert(!('dimensions' in body));
      if (kind === 'openrouter')
        assert.equal(body.input_type, calls === 1 ? 'search_query' : 'search_document');
      return Response.json({ data: [{ index: 0, embedding: [0.6, 0.8] }] });
    });
    assert.deepEqual(await port.embed('query', 'RETRIEVAL_QUERY', signal()), [0.6, 0.8, 0, 0]);
    assert.deepEqual(
      await port.embed('document', 'RETRIEVAL_DOCUMENT', signal()),
      [0.6, 0.8, 0, 0],
    );
    assert(!port.space!.includes(provider.apiKey));
    assert.notEqual(
      port.space,
      providerEmbeddings({ ...connection, id: 'other' }, settings, 4).space,
    );
    assert.notEqual(
      port.space,
      providerEmbeddings(connection, { ...settings, model: 'other' }, 4).space,
    );
    assert.notEqual(
      port.space,
      providerEmbeddings(connection, { ...settings, dimensions: 2 }, 4).space,
    );
  });
}

test('requests respect explicit dimensions, reject invalid vectors and do not retry failures', async () => {
  const port = providerEmbeddings(
    provider,
    { ...settings, dimensions: 2 },
    4,
    async (_url, init) => {
      assert.equal(JSON.parse(init!.body as string).dimensions, 2);
      return Response.json({ data: [{ embedding: [1, 0] }] });
    },
  );
  assert.deepEqual(await port.embed('query', 'RETRIEVAL_QUERY'), [1, 0, 0, 0]);
  for (const payload of [
    { data: [{ embedding: [1, 2, 3, 4, 5] }] },
    { data: [{ embedding: [null] }] },
    { data: [] },
    { data: [{ embedding: 'base64' }] },
  ]) {
    const invalid = providerEmbeddings(provider, settings, 4, async () => Response.json(payload));
    await assert.rejects(invalid.embed('query', 'RETRIEVAL_QUERY'), /Invalid embedding/);
  }
  let calls = 0;
  const failure = providerEmbeddings(provider, settings, 4, async () => {
    calls++;
    return new Response(provider.apiKey, { status: 401 });
  });
  await assert.rejects(
    failure.embed('query', 'RETRIEVAL_QUERY'),
    (error) =>
      error instanceof Error &&
      /401/.test(error.message) &&
      !error.message.includes(provider.apiKey),
  );
  assert.equal(calls, 1);
  const invalidJSON = providerEmbeddings(
    provider,
    settings,
    4,
    async () => new Response(provider.apiKey),
  );
  await assert.rejects(
    invalidJSON.embed('query', 'RETRIEVAL_QUERY'),
    /Invalid embedding provider response/,
  );
});

test('provider catalogs filter OpenAI and Ollama, use OpenRouter embedding endpoint and paginate compatible models', async () => {
  const openai = await providerEmbeddingCatalog(provider, query, signal(), async () =>
    Response.json({ data: [{ id: 'chat' }, { id: 'text-embedding-test' }] }),
  );
  assert.deepEqual(
    openai.items.map((m) => m.id),
    ['text-embedding-test'],
  );
  await providerEmbeddingCatalog(
    { ...provider, kind: 'openrouter' },
    query,
    signal(),
    async (url) => {
      assert.equal(String(url), 'https://openrouter.ai/api/v1/embeddings/models');
      return Response.json({ data: [{ id: 'provider/embed', name: 'Embedding' }] });
    },
  );
  const paths: string[] = [];
  const ollama = await providerEmbeddingCatalog(
    { ...provider, kind: 'ollama' },
    query,
    signal(),
    async (url, init) => {
      paths.push(String(url));
      if (String(url).endsWith('/models'))
        return Response.json({ data: [{ id: 'embed-model' }, { id: 'chat-model' }] });
      const body = JSON.parse(init!.body as string);
      return Response.json({
        capabilities: body.model === 'embed-model' ? ['embedding'] : ['completion'],
      });
    },
  );
  assert.deepEqual(
    ollama.items.map((m) => m.id),
    ['embed-model'],
  );
  assert(paths.includes('http://localhost:11434/api/show'));
  const compatible = await providerEmbeddingCatalog(
    { ...provider, kind: 'compatible', baseUrl: 'https://custom.invalid/v1' },
    { ...query, offset: 1, limit: 1 },
    signal(),
    async () =>
      Response.json({
        data: [
          { id: 'chat', capabilities: ['completion'] },
          { id: 'b' },
          { id: 'a', capabilities: ['embeddings'] },
        ],
      }),
  );
  assert.equal(compatible.total, 2);
  assert.equal(compatible.items[0].id, 'b');
});

test('configured memory resolves provider references and rejects removed/unsupported connections', async () => {
  const config = {
    geminiApiKey: '',
    embeddingModel: 'legacy',
    embeddingDimensions: 4,
    categories: [],
    sharedProfile: '',
  };
  const repo = {
    read: async () => ({ embeddings: settings, providers: [provider] }),
  } as unknown as AISettingsPort;
  let received: AIProvider[] | undefined;
  const configured = new ConfiguredEmbeddings(repo, (value, providers) => {
    received = providers;
    return memoryEmbeddings(config, value, providers);
  });
  assert.equal((await configured.resolve()).enabled, true);
  assert.equal(received?.[0].id, provider.id);
  assert.throws(() => memoryEmbeddings(config, settings, []), /unavailable/);
  assert.throws(
    () => providerEmbeddings({ ...provider, kind: 'codex' }, settings, 4),
    /does not support/,
  );
});

test('admin discovery and test reuse saved keys for draft connections, reject clear keys, preserve references and prevent removing active embedding connections', async () => {
  let value: AISettings = {
    revision: 1,
    providers: [provider],
    models: [{ id: 'chat', provider: provider.id, model: 'chat', label: 'Chat' }],
    defaultModel: 'chat',
    embeddings: settings,
  };
  const repository: AISettingsPort = {
    read: async () => value,
    update: async (next) => {
      value = { ...next, revision: next.revision + 1 };
      return true;
    },
    selectNext: async () => {},
    consumeNext: async () => undefined,
  };
  let key: string | undefined;
  const embedding = new EmbeddingAdmin(
    { model: 'legacy', apiKey: '', dimensions: 4 },
    async (_settings, _query, _signal, connection) => {
      key = connection?.apiKey;
      return { items: [], total: 0 };
    },
    async (_settings, connection) => {
      key = connection?.apiKey;
      return { dimensions: 4 };
    },
  );
  const admin = new AIAdmin(repository, undefined, undefined, embedding);
  let result: any;
  const send = (_status: number, body: unknown) => {
    result = body;
  };
  for (const path of ['/v1/admin/ai/embeddings/models', '/v1/admin/ai/embeddings/test']) {
    await admin.handle(
      { method: 'POST' } as any,
      path,
      async () => ({ embeddings: settings, connection: { ...provider, apiKey: '' } }),
      send,
    );
    assert.equal(key, provider.apiKey);
    if (path.endsWith('/test')) assert.equal(result.dimensions, 4);
  }
  await assert.rejects(
    admin.handle(
      { method: 'POST' } as any,
      '/v1/admin/ai/embeddings/test',
      async () => ({
        embeddings: settings,
        connection: { ...provider, apiKey: '', clearApiKey: true },
      }),
      send,
    ),
    /API key/,
  );
  await assert.rejects(
    admin.handle(
      { method: 'POST' } as any,
      '/v1/admin/ai/embeddings/models',
      async () => ({
        embeddings: settings,
        connection: { ...provider, baseUrl: 'https://user:pass@example.com/v1' },
      }),
      send,
    ),
    /URL/,
  );
  assert.throws(
    () => embedding.merge({ ...settings, dimensions: 5 }, settings, [provider]),
    /dimensiones/,
  );
  const before = value;
  await admin.handle(
    { method: 'PUT' } as any,
    '/v1/admin/ai',
    async () => ({ ...before, embeddings: { ...settings, apiKey: 'should-not-be-stored' } }),
    send,
  );
  assert.equal(value.embeddings?.provider, provider.id);
  assert.equal(value.embeddings?.apiKey, '');
  const { embeddings: _embeddings, ...olderClient } = value;
  await assert.rejects(
    admin.handle(
      { method: 'PUT' } as any,
      '/v1/admin/ai',
      async () => ({
        ...olderClient,
        providers: [{ ...provider, id: 'replacement' }],
        models: [{ ...value.models[0], provider: 'replacement' }],
      }),
      send,
    ),
    /conexión/,
  );
});
