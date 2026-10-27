import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfiguredEmbeddings } from '../src/application/configured-embeddings.js';
import { Memory } from '../src/application/memory.js';
import { EmbeddingAdmin } from '../src/adapters/inbound/embedding-admin.js';
import { AIAdmin } from '../src/adapters/inbound/ai-admin.js';
import { embeddingCatalog, memoryEmbeddings } from '../src/adapters/outbound/memory-embeddings.js';
import { PostgresAI } from '../src/adapters/outbound/postgres-ai.js';
import { Store } from '../src/adapters/outbound/postgres-store.js';
import type { EmbeddingSettings, AISettingsPort } from '../src/domain/ai.js';
import { fixture } from './helpers.js';

const custom: EmbeddingSettings = {
  mode: 'gemini',
  model: 'embedding-new',
  apiKey: 'private-embedding-key',
  baseUrl: '',
};
const query = { search: '', offset: 0, limit: 20 };

test('embedding settings redact keys, preserve them only for unchanged settings, and reject invalid configurations', async () => {
  const admin = new EmbeddingAdmin(
    { model: 'legacy', apiKey: 'server-secret', dimensions: 3072 },
    async () => ({ items: [], total: 0 }),
  );
  assert.equal(admin.read().mode, 'gemini');
  assert.equal(admin.read().model, 'legacy');
  assert.equal(admin.merge({ ...custom, apiKey: '' }).apiKey, 'server-secret');
  assert.equal(
    admin.merge({ ...custom, apiKey: '' }, { ...custom, mode: 'default' }).apiKey,
    'server-secret',
  );
  assert.throws(() => admin.merge({ ...custom, apiKey: '', clearApiKey: true }), /API key/);
  assert.equal(admin.read().apiKey, '');
  assert.equal(admin.read().hasApiKey, true);
  assert.equal(admin.read().secretHint, 'serv••••••••cret');
  assert(!JSON.stringify(admin.read()).includes('server-secret'));
  assert.deepEqual(admin.info.server, {
    provider: 'gemini',
    model: 'legacy',
    dimensions: 3072,
    hasApiKey: true,
  });
  assert(!JSON.stringify(admin.info).includes('server-secret'));
  assert.equal(admin.read(custom).apiKey, '');
  assert.equal(admin.merge({ ...custom, apiKey: '' }, custom).apiKey, custom.apiKey);
  assert.throws(() => admin.merge({ ...custom, apiKey: '', clearApiKey: true }, custom), /API key/);
  assert.throws(() => admin.merge({ ...custom, baseUrl: 'https://different.invalid' }, custom));
  assert.throws(() => admin.merge({ ...custom, model: '' }, custom), /modelo/);
  assert.equal(admin.merge({ ...custom, mode: 'disabled' }, custom).apiKey, '');
  let received: EmbeddingSettings | undefined;
  const discovery = new EmbeddingAdmin(
    { model: 'legacy', apiKey: 'server-secret', dimensions: 3072 },
    async (settings) => {
      received = settings;
      return { items: [], total: 0 };
    },
  );
  await discovery.catalog(
    { mode: 'default', model: '', apiKey: '', baseUrl: '' },
    undefined,
    query,
  );
  assert.equal(received?.apiKey, 'server-secret');
  await discovery.catalog({ ...custom, model: '', apiKey: '' }, custom, query);
  assert.equal(received?.apiKey, custom.apiKey);
});

test('embedding discovery paginates Gemini and excludes conversation models without exposing credentials', async () => {
  let calls = 0;
  const page = await embeddingCatalog(
    custom,
    { search: 'embed', offset: 1, limit: 1 },
    AbortSignal.timeout(5000),
    async (url, options) => {
      calls++;
      assert.equal((options!.headers as Record<string, string>)['x-goog-api-key'], custom.apiKey);
      assert(!String(url).includes(custom.apiKey));
      if (calls === 1)
        return Response.json({
          models: [
            { name: 'models/chat', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embed-one', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'next',
        });
      assert.equal(new URL(String(url)).searchParams.get('pageToken'), 'next');
      return Response.json({
        models: [
          {
            name: 'models/embed-two',
            displayName: 'Second embed',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      });
    },
  );
  assert.equal(page.total, 2);
  assert.equal(page.items[0].id, 'embed-two');
  assert.equal(calls, 2);
});

test('model switches isolate semantic spaces while retaining lexical memories and profile modes', async () => {
  const f = await fixture();
  try {
    let model = 'old';
    let resolutions = 0;
    const repository = {
      read: async () => {
        resolutions++;
        return { embeddings: { ...custom, model } };
      },
    } as unknown as AISettingsPort;
    const embeddings = new ConfiguredEmbeddings(repository, (settings) => ({
      enabled: true,
      space: settings!.model,
      embed: async () => [1, 0],
    }));
    const memory = new Memory(f.config.memory, f.store, embeddings);
    await memory.save('one', { text: 'original keyword', category: 'Facts', tags: [] });
    model = 'new';
    await memory.save('one', { text: 'new keyword', category: 'Facts', tags: [] });
    const semantic = await memory.search('one', 'unrelated');
    assert.equal(semantic.length, 1);
    assert.equal(semantic[0].summary, 'new keyword');
    assert.equal((await memory.search('one', 'original')).length, 2);
    assert.equal((await memory.search('other', 'original')).length, 0);
    const before = resolutions;
    for (const mode of ['simple', 'none'] as const) {
      const scoped = new Memory({ ...f.config.memory, mode }, f.store, embeddings);
      await scoped.search('one', 'keyword');
      if (mode === 'simple')
        await scoped.save('one', { text: 'simple memory', category: 'Facts', tags: [] });
    }
    assert.equal(resolutions, before);
    assert.equal(memoryEmbeddings(f.config.memory, { ...custom, mode: 'disabled' }).enabled, false);
    assert.equal(memoryEmbeddings(f.config.memory, custom).space, 'gemini:embedding-new:2');
  } finally {
    await f.close();
  }
});

test('API saves embedding credentials encrypted, redacts reads, allows optional connection labels and preserves existing references', async () => {
  const f = await fixture();
  try {
    const settings = new PostgresAI(f.store.db, f.config.apiKey);
    await settings.initialize('original');
    const embeddingAdmin = new EmbeddingAdmin(
      { model: 'original', apiKey: '', dimensions: 2 },
      async () => ({ items: [], total: 0 }),
    );
    const admin = new AIAdmin(settings, undefined, undefined, embeddingAdmin);
    const value = await settings.read();
    const send = (_status: number, body: unknown) => {
      result = body;
    };
    let result: any;
    await admin.handle(
      { method: 'PUT' } as any,
      '/v1/admin/ai',
      async () => ({
        ...value,
        providers: value.providers.map((p) => ({ ...p, name: '' })),
        embeddings: custom,
      }),
      send,
    );
    assert.equal((await settings.read()).embeddings?.apiKey, custom.apiKey);
    const raw = (await f.store.pool.query('SELECT value FROM ai_settings')).rows[0].value;
    assert(!raw.includes(custom.apiKey));
    await admin.handle({ method: 'GET' } as any, '/v1/admin/ai', async () => ({}), send);
    assert.equal(result.embeddings.apiKey, '');
    assert.equal(result.embeddings.hasApiKey, true);
    assert.equal(result.embeddingInfo.reranker, false);
    assert.equal(result.models[0].id, value.models[0].id);
    // An older client omitting the new controls must not erase the stored configuration.
    await admin.handle(
      { method: 'PUT' } as any,
      '/v1/admin/ai',
      async () => ({ ...value, revision: 2 }),
      send,
    );
    assert.equal((await settings.read()).embeddings?.model, custom.model);
  } finally {
    await f.close();
  }
});

test('initialization labels unassigned legacy vectors without rewriting their values', async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  try {
    await f.store.insertMemory(
      'one',
      { text: 'legacy record', category: 'Facts', tags: [] },
      [1, 0],
    );
    await f.store.pool.query('UPDATE memories SET embedding_space = NULL');
    await f.store.close();
    reopened = await Store.open(f.url, 2, f.schema, 'legacy-model');
    const row = (await reopened.pool.query('SELECT embedding::text,embedding_space FROM memories'))
      .rows[0];
    assert.equal(row.embedding, '[1,0]');
    assert.equal(row.embedding_space, 'legacy-model');
    assert.equal(
      (
        await reopened.searchMemory(
          'one',
          'unrelated',
          [1, 0],
          [],
          undefined,
          undefined,
          'other-model',
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await reopened.searchMemory(
          'one',
          'unrelated',
          [1, 0],
          [],
          undefined,
          undefined,
          'legacy-model',
        )
      ).length,
      1,
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('confirmed key deletion is immediate, revision checked and never falls back to server embeddings', async () => {
  let value = {
    revision: 1,
    defaultModel: 'one',
    models: [{ id: 'one', label: 'One', provider: 'gemini', model: 'chat' }],
    providers: [
      {
        id: 'gemini',
        name: 'Gemini',
        kind: 'openai' as const,
        baseUrl: '',
        apiKey: 'provider-secret',
      },
    ],
    embeddings: { ...custom },
  };
  const admin = new AIAdmin({
    read: async () => value,
    update: async (next) => {
      value = { ...next, revision: value.revision + 1 } as typeof value;
      return true;
    },
    selectNext: async () => {},
    consumeNext: async () => undefined,
  });
  let status = 0;
  const send = (code: number) => {
    status = code;
  };
  await admin.handle(
    { method: 'DELETE' } as any,
    '/v1/admin/ai/api-key',
    async () => ({ revision: 0 }),
    send,
  );
  assert.equal(status, 409);
  assert.equal(value.embeddings.apiKey, custom.apiKey);
  await admin.handle(
    { method: 'DELETE' } as any,
    '/v1/admin/ai/api-key',
    async () => ({ revision: 1 }),
    send,
  );
  assert.equal(status, 200);
  assert.equal(value.embeddings.apiKey, '');
  assert.equal(value.embeddings.mode, 'disabled');
  assert.equal(value.providers[0].apiKey, 'provider-secret');
  await admin.handle(
    { method: 'DELETE' } as any,
    '/v1/admin/ai/api-key',
    async () => ({ revision: 2, provider: 'gemini' }),
    send,
  );
  assert.equal(value.providers[0].apiKey, '');
});
