import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AISettings, AISettingsPort } from '../src/domain/ai.js';
import type { MemoryMatch } from '../src/domain/models.js';
import { ModelMemoryReranker } from '../src/application/memory-reranker.js';
import { Memory } from '../src/application/memory.js';
import { Mem0Repository } from '../src/adapters/outbound/mem0-repository.js';
import { httpRerank } from '../src/adapters/outbound/http-reranker.js';
import { EmbeddingAdmin } from '../src/adapters/inbound/embedding-admin.js';
import { memoryEmbeddings } from '../src/adapters/outbound/memory-embeddings.js';
import { AIAdmin } from '../src/adapters/inbound/ai-admin.js';
import { fixture } from './helpers.js';
import type { IncomingMessage } from 'node:http';

const settings = (): AISettings => ({
  revision: 1,
  defaultModel: 'conversation',
  providers: [{ id: 'local', kind: 'codex', name: 'Codex', baseUrl: '', apiKey: '' }],
  models: [
    { id: 'conversation', provider: 'local', model: 'chat-model', label: 'Chat' },
    { id: 'ranking', provider: 'local', model: 'rank-model', label: 'Ranking' },
  ],
  reranking: { enabled: true, provider: 'local', model: 'rank-model' },
});
const candidate = (id: string): MemoryMatch => ({
  id,
  text: `Scoped memory ${id}`,
  summary: null,
  superseded_by: null,
  similarity: 1,
  metadata: { category: 'General', tags: [], created_at: '2026-10-27T00:00:00.000Z' },
});

test('reranking uses the configured model, bounds data, rejects invented/duplicate IDs and preserves candidates on failure', async () => {
  const value = settings();
  const repo = { read: async () => value } as AISettingsPort;
  const candidates = Array.from({ length: 25 }, (_, i) => candidate(String(i + 1)));
  let output = '{"ids":["3","1"]}',
    calls = 0;
  const ranker = new ModelMemoryReranker(repo, (provider, model) => {
    assert.equal(model.model, 'rank-model');
    assert.equal(provider.id, 'local');
    return {
      async run(session, prompt, _instructions, context, _images, schema, tools) {
        calls++;
        assert(session.startsWith('system:rerank:'));
        assert.equal(context.session, 'alice');
        assert.equal(context.userQuestion, false);
        assert.equal(tools, false);
        assert(schema);
        assert.equal(JSON.parse(prompt).memories.length, 20);
        assert.equal(JSON.parse(prompt).query.length, 4000);
        return output;
      },
    };
  });
  const ranked = await ranker.rank('alice', 'q'.repeat(5000), candidates);
  assert.deepEqual(
    ranked.slice(0, 3).map((item) => item.id),
    ['3', '1', '2'],
  );
  assert.equal(ranked.length, 25);
  output = '{"ids":["999"]}';
  assert.deepEqual(await ranker.rank('alice', 'q'.repeat(5000), candidates), candidates);
  output = '{"ids":["1","1"]}';
  assert.deepEqual(await ranker.rank('alice', 'q'.repeat(5000), candidates), candidates);
  value.reranking!.enabled = false;
  await ranker.rank('alice', 'unused', candidates);
  assert.equal(calls, 3);
});

test('AI settings persist reranking selection and reject a removed or unsupported model', async () => {
  let value = settings();
  const repo = {
    read: async () => value,
    update: async (next: AISettings) => {
      value = next;
      return true;
    },
  } as AISettingsPort;
  const admin = new AIAdmin(repo);
  const put = async (body: unknown) => {
    let status = 0;
    await admin.handle(
      { method: 'PUT' } as IncomingMessage,
      '/v1/admin/ai',
      async () => body,
      (code) => {
        status = code;
      },
    );
    return status;
  };
  assert.equal(await put(value), 200);
  assert.equal(value.reranking?.model, 'rank-model');
  await assert.rejects(
    () => put({ ...value, reranking: { ...value.reranking, provider: 'missing' } }),
    /reranking/,
  );
  await assert.rejects(
    () =>
      put({
        ...value,
        providers: [{ ...value.providers[0], kind: 'home_assistant' }],
        models: value.models.map((item) => ({ ...item, model: 'preferred' })),
      }),
    /reranking/,
  );
});

test('scoped relation expansion retrieves linked entities without crossing profiles, expired records, supersessions or filters', async () => {
  const f = await fixture();
  try {
    const repo = new Mem0Repository(f.store.pool, 2, f.store);
    const save = async (
      session: string,
      text: string,
      entities: string[],
      relations: { subject: string; predicate: string; object: string }[] = [],
      expiresAt?: string,
    ) =>
      repo.insertMemory(
        session,
        { text, category: 'Work', tags: [], entities, relations, expiresAt },
        null,
      );
    await save(
      'alice',
      'Ana founded Acme',
      ['Ana', 'Acme'],
      [{ subject: 'Ana', predicate: 'founded', object: 'Acme' }],
    );
    await save('alice', 'The launch is on Monday', ['Acme']);
    await save('bob', 'Private Acme access code', ['Acme']);
    await save('alice', 'Old confidential plan', ['Acme'], [], '2000-01-01T00:00:00.000Z');
    const hits = await repo.searchMemory('alice', 'What is Ana planning?', undefined, []);
    assert(hits.some((hit) => hit.text === 'The launch is on Monday'));
    assert(!hits.some((hit) => /Private|confidential/.test(hit.text)));
    assert.deepEqual(await repo.searchMemory('alice', 'Ana', undefined, ['Health']), []);
    const original = hits.find((hit) => hit.text === 'Ana founded Acme')!;
    assert.deepEqual(original.metadata.relations, [
      { subject: 'Ana', predicate: 'founded', object: 'Acme' },
    ]);
    await repo.insertMemory(
      'alice',
      {
        text: 'Ana now founded Newco',
        category: 'Work',
        tags: [],
        entities: ['Ana', 'Newco'],
        supersedes: [original.id],
      },
      null,
    );
    const updated = await repo.searchMemory('alice', 'Ana', undefined, []);
    assert(!updated.some((hit) => hit.id === original.id));
    assert(!updated.some((hit) => hit.text === 'The launch is on Monday'));
  } finally {
    await f.close();
  }
});

test('expiration hides recalls, tool lists and catalogs but retains administrative inspection and deletion', async () => {
  const f = await fixture();
  try {
    const repo = new Mem0Repository(f.store.pool, 2, f.store);
    const memory = new Memory({ ...f.config.memory, mode: 'simple' }, repo, {
      enabled: false,
      async embed() {
        throw Error('No embedding');
      },
    });
    await memory.save('alice', {
      text: 'Current plan',
      category: 'Plans',
      tags: [],
      expiresAt: '2099-01-01T12:00:00.000Z',
    });
    await repo.insertMemory(
      'alice',
      {
        text: 'Expired plan',
        category: 'Expired',
        tags: ['old'],
        expiresAt: '2000-01-01T12:00:00.000Z',
      },
      null,
    );
    const admin = await repo.memories('alice', '', undefined, 0, 20, true);
    const expired = (admin.items as { id: string; expired?: boolean }[]).find(
      (item) => item.expired,
    )!;
    assert(expired);
    assert.equal((await repo.memories('alice', '', undefined, 0, 20)).total, 1);
    assert.equal((await memory.search('alice', 'plan')).length, 1);
    assert.deepEqual(await memory.catalog('alice'), { categories: ['Plans'], tags: [] });
    assert(await repo.readMemory('alice', expired.id));
    await assert.rejects(() => memory.read('alice', expired.id), /not found/);
    await assert.rejects(
      () =>
        memory.save('alice', {
          text: 'past',
          category: 'x',
          tags: [],
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
      /future/,
    );
    const stored = (
      await f.store.pool.query(
        "SELECT payload->>'expires_at' AS precise,payload->>'expiration_date' AS day FROM zero_mem0_vectors WHERE payload->>'data'='Current plan'",
      )
    ).rows[0];
    assert.equal(stored.precise, '2099-01-01T12:00:00.000Z');
    assert.equal(stored.day, '2099-01-01');
    assert.equal(await repo.forget('alice', [expired.id]), 1);
  } finally {
    await f.close();
  }
});

test('memory-only connections are independent from conversation models, reusable and redacted', async () => {
  let value = settings();
  const repo = {
    read: async () => value,
    update: async (next: AISettings) => {
      value = next;
      return true;
    },
  } as AISettingsPort;
  const admin = new AIAdmin(
    repo,
    undefined,
    undefined,
    new EmbeddingAdmin({ model: 'legacy', apiKey: '', dimensions: 2 }, async () => ({
      items: [],
      total: 0,
    })),
  );
  const provider = {
    id: 'memory-only',
    kind: 'compatible' as const,
    scope: 'embeddings' as const,
    name: 'Memory',
    baseUrl: 'https://memory.example/v1',
    apiKey: 'private-memory-key',
  };
  value = {
    ...value,
    providers: [...value.providers, provider],
    embeddings: {
      mode: 'provider',
      provider: provider.id,
      model: 'embed-model',
      baseUrl: '',
      apiKey: '',
    },
    reranking: { enabled: true, provider: provider.id, model: 'rerank-model', api: 'rerank' },
  };
  await admin.handle(
    { method: 'PUT' } as IncomingMessage,
    '/v1/admin/ai',
    async () => value,
    () => {},
  );
  assert(!value.models.some((model) => model.provider === provider.id));
  let exposed: unknown;
  await admin.handle(
    { method: 'GET' } as IncomingMessage,
    '/v1/admin/ai',
    async () => null,
    (_status, body) => {
      exposed = body;
    },
  );
  assert(!JSON.stringify(exposed).includes('private-memory-key'));
  assert.equal(value.providers.find((item) => item.id === provider.id)?.scope, 'embeddings');
  const embed = memoryEmbeddings(
    { geminiApiKey: '', sharedProfile: '', embeddingModel: 'legacy', embeddingDimensions: 2 },
    value.embeddings,
    value.providers,
    async (_url, options) => {
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        'Bearer private-memory-key',
      );
      return Response.json({ data: [{ embedding: [1, 0] }] });
    },
  );
  assert.deepEqual(await embed.embed('sample', 'RETRIEVAL_DOCUMENT'), [1, 0]);
  await assert.rejects(
    () =>
      admin.handle(
        { method: 'PUT' } as IncomingMessage,
        '/v1/admin/ai',
        async () => ({
          ...value,
          models: [
            ...value.models,
            { id: 'invalid-chat', provider: provider.id, model: 'embed-model', label: 'Invalid' },
          ],
        }),
        () => {},
      ),
    /proveedores/,
  );
});

test('native reranking sends bounded documents to the dedicated endpoint and validates returned indices without retrying', async () => {
  const provider = {
    id: 'rank-only',
    kind: 'compatible' as const,
    scope: 'reranking' as const,
    name: 'Ranker',
    baseUrl: 'https://rank.example/v2',
    apiKey: 'private-rank-key',
  };
  let calls = 0;
  const indices = await httpRerank(
    provider,
    'rerank-model',
    'question',
    ['first', 'second'],
    AbortSignal.timeout(5000),
    async (url, options) => {
      calls++;
      assert.equal(String(url), 'https://rank.example/v2/rerank');
      assert.equal(options?.redirect, 'error');
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        'Bearer private-rank-key',
      );
      assert.equal(JSON.parse(String(options?.body)).model, 'rerank-model');
      return Response.json({
        results: [
          { index: 0, relevance_score: 0.2 },
          { index: 1, relevance_score: 0.9 },
        ],
      });
    },
  );
  assert.deepEqual(indices, [1, 0]);
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      httpRerank(provider, 'm', 'q', ['one'], AbortSignal.timeout(5000), async () =>
        Response.json({ results: [{ index: 9, relevance_score: 1 }] }),
      ),
    /indices/,
  );
  const value = {
    ...settings(),
    providers: [provider],
    reranking: {
      enabled: true,
      provider: provider.id,
      model: 'rerank-model',
      api: 'rerank' as const,
    },
  };
  const ranker = new ModelMemoryReranker(
    { read: async () => value } as AISettingsPort,
    () => {
      throw Error('No conversation agent');
    },
    async () => [1, 0],
  );
  assert.deepEqual(
    (await ranker.rank('alice', 'q', [candidate('1'), candidate('2')])).map((item) => item.id),
    ['2', '1'],
  );
});
