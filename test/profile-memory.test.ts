import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Access, scopedConfig } from '../src/application/access.js';
import { Memory } from '../src/application/memory.js';
import { Tools } from '../src/application/tool-registry.js';
import { Scheduler } from '../src/application/scheduler.js';
import { ProcessMessage } from '../src/application/use-cases/process-message.js';
import { ConsolidateMemory } from '../src/application/use-cases/consolidate-memory.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { registerMemoryTools } from '../src/adapters/inbound/integration-tools.js';
import type { GooglePort, TelegramPort } from '../src/application/ports.js';
import type { AccessProfile } from '../src/domain/access.js';
import type { MemoryMode } from '../src/domain/memory.js';
import { fixture } from './helpers.js';

const profile = (mode: MemoryMode): AccessProfile => ({
  bot: 'salem',
  chatId: '1',
  kind: 'user',
  label: 'User',
  enabled: true,
  owner: false,
  capabilities: ['web', 'transcription', 'documents'],
  memoryMode: mode,
  timezone: 'America/New_York',
});
const google: GooglePort = {
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
const signal = () => new AbortController().signal;

test('advanced memory embeds, simple memory uses only keywords, none cannot access stored memories', async () => {
  const f = await fixture();
  let embeddingCalls = 0;
  const embeddings = {
    enabled: true,
    async embed() {
      embeddingCalls++;
      return [1, 0];
    },
  };
  try {
    f.config.memory.geminiApiKey = 'test-embedding-key';
    const advancedConfig = scopedConfig(f.config, profile('advanced'));
    assert.equal(advancedConfig.timezone, 'America/New_York');
    assert.equal(advancedConfig.memory.geminiApiKey, 'test-embedding-key');
    const advanced = new Memory(advancedConfig.memory, f.store, embeddings);
    await advanced.save('salem:1', {
      text: 'Remember apples for shopping',
      category: 'food',
      tags: [],
    });
    assert.equal((await advanced.search('salem:1', 'apples')).length, 1);
    assert.equal(embeddingCalls, 2);
    const simpleConfig = scopedConfig(f.config, profile('simple'));
    assert.equal(simpleConfig.memory.geminiApiKey, '');
    const simple = new Memory(simpleConfig.memory, f.store, embeddings);
    await simple.save('salem:1', {
      text: 'Remember oranges for shopping',
      category: 'food',
      tags: [],
    });
    assert.equal((await simple.search('salem:1', 'oranges')).length, 1);
    assert.equal(
      (await simple.search('salem:1', 'apples')).length,
      1,
      'Old embedded facts stay searchable by keywords',
    );
    assert.equal(
      embeddingCalls,
      2,
      'Simple mode must not call an embedding provider even if the adapter is enabled',
    );
    const rows = (
      await f.store.pool.query('SELECT embedding IS NOT NULL AS embedded FROM memories ORDER BY id')
    ).rows;
    assert.deepEqual(
      rows.map((row) => row.embedded),
      [true, false],
    );
    const noneConfig = scopedConfig(f.config, {
      ...profile('none'),
      google: {
        ...f.config.google,
        refreshToken: 'private',
        contextDocumentId: 'old-context',
        documentFolderId: 'chosen-folder',
      },
    });
    assert.equal(noneConfig.google.contextDocumentId, '');
    assert.equal(noneConfig.google.documentFolderId, 'chosen-folder');
    assert.equal(noneConfig.memory.geminiApiKey, '');
    const none = new Memory(noneConfig.memory, f.store, embeddings);
    await assert.rejects(
      () => none.save('salem:1', { text: 'Must not save', category: 'x', tags: [] }),
      /disabled/,
    );
    assert.deepEqual(await none.search('salem:1', 'apples'), []);
    assert.deepEqual(await none.catalog('salem:1'), { categories: [], tags: [] });
    assert.deepEqual(await none.pending('salem:1'), []);
    await assert.rejects(() => none.read('salem:1', '1'), /disabled/);
    await none.consolidate('salem:1', [{ text: 'Must not save', category: 'x', tags: [] }], [1]);
    assert.equal((await f.store.pool.query('SELECT count(*) FROM memories')).rows[0].count, '2');
    assert.equal(embeddingCalls, 2);
    for (const mode of ['advanced', 'simple', 'none'] as const) {
      const tools = new Tools(f.store);
      registerMemoryTools(
        tools,
        new Memory({ ...f.config.memory, mode }, f.store, embeddings),
        mode,
      );
      assert.equal(tools.definitions().length, mode === 'none' ? 0 : 4);
      if (mode === 'simple')
        assert.match(
          tools.definitions().find((t) => t.name === 'memories_get')!.description,
          /by keywords/,
        );
    }
    assert.equal(
      (await advanced.search('salem:1', 'oranges')).length,
      2,
      'Advanced mode can still find simple facts through hybrid retrieval',
    );
  } finally {
    await f.close();
  }
});

test('no long-term memory retains conversation while excluding off-period messages from future consolidation', async () => {
  const f = await fixture();
  const config = scopedConfig(f.config, profile('none'));
  await f.store.addMessage('salem:1', 'user', 'Previous conversational context', false);
  const process = new ProcessMessage(
    config,
    f.store,
    {
      async run(_session, prompt, instructions) {
        assert.match(prompt, /Previous conversational context/);
        assert.match(instructions, /Long-term memory is disabled/);
        assert.match(instructions, /Current timezone: America\/New_York/);
        assert(!instructions.includes('Use memory_save'));
        return 'Conversation continues';
      },
    },
    {
      ...google,
      enabled: true,
      async context() {
        throw new Error('Disabled memory must not load an external context document');
      },
    },
    {} as TelegramPort,
    '',
    'Salem',
  );
  try {
    const context = {
      session: 'salem:1',
      jobId: 'none',
      signal: signal(),
      memoryMode: 'none' as const,
    };
    const result = await process.execute(
      {
        id: 'none',
        session: 'salem:1',
        status: 'running',
        payload: { kind: 'chat', text: 'Continue talking' },
      },
      context,
    );
    assert.equal(result.output, 'Conversation continues');
    assert.equal((await f.store.history('salem:1')).length, 3);
    assert.deepEqual(await f.store.pendingMemoryMessages('salem:1'), []);
    const restored = new Memory({ ...config.memory, mode: 'simple' }, f.store, {
      enabled: false,
      async embed() {
        throw new Error('Must not embed');
      },
    });
    assert.deepEqual(await restored.pending('salem:1'), []);
    const consolidation = new ConsolidateMemory(
      {
        async run() {
          throw new Error('Disabled memory must not invoke the model');
        },
      },
      google,
      restored,
      '',
    );
    assert.equal(
      (
        await consolidation.execute(
          { id: 'none', session: 'salem:1', status: 'running', payload: {} },
          context,
        )
      ).deliver,
      false,
    );
  } finally {
    await f.close();
  }
});

test('per-chat schedules follow local calendar days and DST, skip consolidation when memory is off, and keep daily resets', async () => {
  const f = await fixture();
  f.config.schedules.enabled = true;
  f.config.schedules.reset = '00:00';
  f.config.schedules.consolidate = '23:59';
  f.config.schedules.morning = '';
  f.config.schedules.eventReminders = false;
  const policies = new Map([
    ['salem:1', { enabled: true, timezone: 'Asia/Tokyo', memoryMode: 'simple' as const }],
    ['salem:-2', { enabled: true, timezone: 'America/New_York', memoryMode: 'advanced' as const }],
    ['salem:3', { enabled: true, timezone: 'Asia/Tokyo', memoryMode: 'none' as const }],
    ['salem:4', { enabled: false, timezone: 'Asia/Tokyo', memoryMode: 'advanced' as const }],
  ]);
  for (const session of policies.keys()) {
    await f.store.setThread(session, 'thread');
    await f.store.addMessage(session, 'user', 'Pending fact');
  }
  const memory = new Memory(f.config.memory, f.store, {
    enabled: false,
    async embed() {
      return [];
    },
  });
  const scheduler = new Scheduler(
    f.config,
    f.store,
    memory,
    async (session) => policies.get(session)!,
  );
  const jobs = async (kind: string) =>
    (
      await f.store.pool.query(
        "SELECT session,dedupe FROM jobs WHERE payload->>'kind'=$1 ORDER BY sequence",
        [kind],
      )
    ).rows;
  try {
    await scheduler.tick(new Date('2026-10-16T14:59:00Z'));
    await scheduler.tick(new Date('2026-10-16T14:59:15Z'));
    assert.deepEqual(
      (await jobs('consolidate')).map((row) => row.session),
      ['salem:1'],
    );
    await scheduler.tick(new Date('2026-10-16T15:00:00Z'));
    const resets = await jobs('reset');
    assert.deepEqual(
      resets.map((row) => row.session),
      ['salem:1', 'salem:3'],
    );
    assert(resets.every((row) => row.dedupe.startsWith('reset:2026-10-17:')));
    await scheduler.tick(new Date('2026-10-17T03:59:00Z'));
    assert.deepEqual(
      (await jobs('consolidate')).map((row) => row.session),
      ['salem:1', 'salem:-2'],
    );
    assert.equal((await jobs('consolidate'))[1].dedupe, 'memory:2026-10-16:salem:-2');
    f.config.schedules.reset = '01:30';
    await scheduler.tick(new Date('2026-11-01T05:30:00Z'));
    await scheduler.tick(new Date('2026-11-01T06:30:00Z'));
    assert.equal(
      (await jobs('reset')).filter((row) => row.session === 'salem:-2').length,
      1,
      'Repeated DST hour must not run a reset twice',
    );
    await memory.save('salem:-2', {
      text: 'Durable fact survives daily reset',
      category: 'x',
      tags: [],
    });
    await f.store.reset('salem:-2');
    assert.equal((await memory.search('salem:-2', 'Durable')).length, 1);
  } finally {
    await f.close();
  }
});

test('admin stores independent memory mode and timezone, validates values, and preserves settings when omitted', async () => {
  const f = await fixture();
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  await repository.discover('salem', '1', 'User', 'user');
  const access = new Access(repository, f.store);
  const server = createHttpServer(f.config, f.store, undefined, {
    access,
    admin: new Admin(f.config, repository, async () => {}),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1/admin/profiles/salem/1`;
  const headers = {
    Authorization: `Bearer ${f.config.apiKey}`,
    'Content-Type': 'application/json',
  };
  const put = (settings: unknown) =>
    fetch(base, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        label: 'User',
        kind: 'user',
        enabled: true,
        capabilities: ['web'],
        ...(settings as object),
      }),
    });
  try {
    const initial = (await (await fetch(base, { headers })).json()) as any;
    assert.equal(initial.memoryMode, 'advanced');
    assert.equal(initial.timezone, f.config.timezone);
    for (const mode of ['simple', 'none', 'advanced']) {
      assert.equal((await put({ memoryMode: mode, timezone: 'Pacific/Auckland' })).status, 200);
      assert.equal((await repository.profile('salem', '1'))?.memoryMode, mode);
    }
    assert.equal((await put({ memoryMode: 'none', timezone: 'America/New_York' })).status, 200);
    assert.equal((await put({})).status, 200);
    const retained = (await repository.profile('salem', '1'))!;
    assert.equal(retained.memoryMode, 'none');
    assert.equal(retained.timezone, 'America/New_York');
    await repository.initialize(f.config);
    assert.equal((await repository.profile('salem', '1'))?.memoryMode, 'none');
    assert.equal((await put({ memoryMode: 'invalid' })).status, 400);
    assert.equal((await put({ timezone: 'Not/A_Timezone' })).status, 400);
    assert.equal((await put({ timezone: '' })).status, 400);
    await repository.discover('salem', '-2', 'Group', 'group');
    assert.equal((await repository.profile('salem', '-2'))?.memoryMode, 'advanced');
    assert.equal((await repository.profile('salem', '-2'))?.timezone, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('consolidation uses the chat timezone and rechecks memory mode before saving generated facts', async () => {
  const f = await fixture();
  let allowed = true,
    turns = 0;
  const memory = new Memory({ ...f.config.memory, mode: 'simple' }, f.store, {
    enabled: true,
    async embed() {
      throw new Error('Simple consolidation must not embed');
    },
  });
  await f.store.addMessage('salem:1', 'user', 'A fact to consolidate');
  const consolidation = new ConsolidateMemory(
    {
      async run(_session, _prompt, instructions) {
        turns++;
        assert.match(instructions, /Current timezone: America\/New_York/);
        if (turns === 1) allowed = false;
        return JSON.stringify({
          fragments: [{ text: 'A durable fact', metadata: { category: 'x', tags: [] } }],
        });
      },
    },
    google,
    memory,
    '',
    [],
    'America/New_York',
    async () => (allowed ? memory : undefined),
  );
  const context = () => ({
    session: 'salem:1',
    jobId: 'consolidation',
    signal: signal(),
    memoryMode: 'simple' as const,
  });
  const job = {
    id: 'consolidation',
    session: 'salem:1',
    status: 'running',
    payload: { kind: 'consolidate' },
  };
  try {
    await consolidation.execute(job, context());
    assert.equal((await f.store.pool.query('SELECT count(*) FROM memories')).rows[0].count, '0');
    assert.equal((await memory.pending('salem:1')).length, 1);
    allowed = true;
    await consolidation.execute(job, context());
    assert.equal((await memory.pending('salem:1')).length, 0);
    const saved = (await f.store.pool.query('SELECT session,embedding FROM memories')).rows;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].session, 'salem:1');
    assert.equal(saved[0].embedding, null);
  } finally {
    await f.close();
  }
});
