import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/application/memory.js';
import { ExtractMemory, type MemoryTurn } from '../src/application/memory-extraction.js';
import { Mem0Extractor } from '../src/adapters/outbound/mem0-extractor.js';
import { Mem0Repository } from '../src/adapters/outbound/mem0-repository.js';
import { ProcessMessage } from '../src/application/use-cases/process-message.js';
import type { AgentPort, GooglePort, TelegramPort } from '../src/application/ports.js';
import { fixture } from './helpers.js';

const turn: MemoryTurn = {
  source: 'conversation-job',
  profile: 'one',
  messages: [
    {
      role: 'user',
      content: 'How can I organize my backups?',
      created: '2026-10-27T12:00:00.000Z',
    },
    {
      role: 'assistant',
      content: 'I recommend encrypted offsite backups.',
      created: '2026-10-27T12:00:01.000Z',
    },
  ],
};
const context = () => ({
  session: 'one',
  jobId: 'extraction-job',
  signal: new AbortController().signal,
});
const advice = 'The assistant recommended encrypted offsite backups to the user.';
const response = () =>
  JSON.stringify({
    memory: [
      {
        id: '0',
        text: advice,
        summary: advice,
        category: 'Ideas',
        tags: ['backups'],
        attributed_to: 'assistant',
        entities: [],
        relations: [],
        expiresAt: null,
      },
    ],
  });

test('real Mem0 inference reads both speakers and publishes attributed memories with scoped stable IDs', async () => {
  const f = await fixture();
  try {
    const repository = new Mem0Repository(f.store.pool, 2, f.store);
    const memory = new Memory({ ...f.config.memory, mode: 'simple' }, repository, {
      enabled: true,
      async embed() {
        throw new Error('Simple mode must not embed');
      },
    });
    let calls = 0;
    const agent: AgentPort = {
      async run(session, prompt, instructions, ctx, images, schema, tools) {
        calls++;
        assert.equal(session, 'system:memory:extraction-job');
        assert.equal(ctx.session, 'one');
        assert.equal(ctx.userQuestion, false);
        assert.equal(tools, false);
        assert(schema);
        // Strict structured output rejects optional object properties at any depth.
        const assertStrictObjects = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          const node = value as Record<string, unknown>;
          if (node.type === 'object') {
            assert.equal(node.additionalProperties, false);
            assert.deepEqual(
              [...((node.required as string[]) || [])].sort(),
              Object.keys((node.properties as object) || {}).sort(),
            );
          }
          for (const child of Object.values(node)) {
            if (Array.isArray(child)) child.forEach(assertStrictObjects);
            else assertStrictObjects(child);
          }
        };
        assertStrictObjects(schema);
        assert.match(prompt, /user: \[2026-10-27T12:00:00.000Z\] How can I organize/);
        assert.match(prompt, /assistant: \[2026-10-27T12:00:01.000Z\] I recommend/);
        assert.match(prompt, /Current timezone: Europe\/Madrid/);
        assert.match(prompt, /assistant recommendations are not user decisions/i);
        assert.match(instructions, /Memory Extractor/);
        assert(!prompt.includes('Private advice for another session'));
        return response();
      },
    };
    await memory.save('two', {
      text: 'Private advice for another session',
      category: 'Private',
      tags: [],
    });
    const extract = new ExtractMemory(new Mem0Extractor(agent), async () => ({
      memory,
      profile: 'one',
      timezone: 'Europe/Madrid',
      enabled: true,
    }));
    const result = await extract.execute(turn, context());
    assert.equal(result.deliver, false);
    assert.equal(result.output, 'Extracted 1 memories');
    assert.equal(calls, 1);
    const found = await memory.search('one', 'backups');
    assert.equal(found[0]?.summary, advice);
    assert.deepEqual(await memory.search('two', 'encrypted'), []);
    await f.store.reset('one');
    assert.equal((await memory.search('one', 'backups'))[0]?.id, found[0].id);
    assert.deepEqual(await memory.catalog('one'), { categories: ['Ideas'], tags: ['backups'] });
  } finally {
    await f.close();
  }
});

test('Mem0 skips existing inferred facts, accepts empty extraction and rejects malformed inference', async () => {
  const extractor = (run: AgentPort['run']) => new Mem0Extractor({ run });
  assert.deepEqual(
    await extractor(async () => response()).extract(turn, [advice], '', context()),
    [],
  );
  assert.deepEqual(
    await extractor(async () => '{"memory":[]}').extract(turn, [], '', context()),
    [],
  );
  await assert.rejects(
    () => extractor(async () => '{bad json').extract(turn, [], '', context()),
    /extraction failed/,
  );
  await assert.rejects(
    () =>
      extractor(async () => '{"memory":[{"id":"0","text":"missing attribution"}]}').extract(
        turn,
        [],
        '',
        context(),
      ),
    /extraction failed/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    extractor(async () => response()).extract(turn, [], '', {
      ...context(),
      signal: controller.signal,
    }),
  );
});

test('automatic extraction queues only completed conversations and excludes disabled-memory turns and commands', async () => {
  const f = await fixture();
  try {
    const make = () =>
      new ProcessMessage(
        f.config,
        f.store,
        {
          async run() {
            return 'Assistant reply';
          },
        },
        { enabled: false } as GooglePort,
        {} as TelegramPort,
        '',
        'Zero',
        'automatic',
        '',
        true,
      );
    const job = (id: string, text: string) => ({
      id,
      session: 'one',
      status: 'running',
      payload: { kind: 'chat', text },
    });
    await make().execute(job('first', 'User question'), context());
    const queued = await f.store.claim([]);
    assert.equal(queued?.payload.kind, 'memory_extract');
    assert.equal(queued?.session, 'one');
    assert.equal(queued?.payload.turn.source, 'first');
    assert.deepEqual(
      queued?.payload.turn.messages.map((m: any) => [m.role, m.content]),
      [
        ['user', 'User question'],
        ['assistant', 'Assistant reply'],
      ],
    );
    await f.store.finish(queued!.id, 'done');
    f.config.memory.mode = 'none';
    await make().execute(job('disabled', 'Do not retain'), context());
    f.config.memory.mode = 'simple';
    await make().execute(job('reset', '/nuevo'), context());
    assert.equal(await f.store.claim([]), undefined);
    assert.deepEqual(await f.store.pendingMemoryMessages('one'), []);
  } finally {
    await f.close();
  }
});

test('disabled extraction never invokes Mem0 and uncertain publication is not retried', async () => {
  const f = await fixture();
  try {
    const memory = new Memory(f.config.memory, f.store, {
      enabled: false,
      async embed() {
        return [];
      },
    });
    let calls = 0;
    const extractor = {
      async extract() {
        calls++;
        return [{ text: advice, category: 'Ideas', tags: [] }];
      },
    };
    const current = async () => ({
      memory,
      profile: 'one',
      timezone: 'Europe/Madrid',
      enabled: false,
    });
    await new ExtractMemory(extractor, current).execute(turn, context());
    assert.equal(calls, 0);
    let writes = 0;
    memory.save = async () => {
      writes++;
      throw new Error('Uncertain write');
    };
    await assert.rejects(
      () =>
        new ExtractMemory(extractor, async () => ({ ...(await current()), enabled: true })).execute(
          turn,
          context(),
        ),
      /Uncertain write/,
    );
    assert.equal(writes, 1);
  } finally {
    await f.close();
  }
});
