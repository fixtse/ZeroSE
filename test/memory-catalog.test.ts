import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/application/memory.js';
import { ProcessMessage } from '../src/application/use-cases/process-message.js';
import { Tools } from '../src/application/tool-registry.js';
import { registerMemoryTools } from '../src/adapters/inbound/integration-tools.js';
import { tokens, TOOL_RESULT_TOKENS } from '../src/application/context-budget.js';
import type { GooglePort, TelegramPort } from '../src/application/ports.js';
import { fixture } from './helpers.js';

const context = { session: 'owner', jobId: 'catalog', signal: new AbortController().signal };

test('normal turns use only a bounded configured category list without catalog reads', async () => {
  const f = await fixture();
  try {
    f.config.memory.categories = Array.from({ length: 15 }, (_, i) => `Configured${i}`);
    await f.store.insertMemory(
      'owner',
      { text: 'A remembered fact', category: 'CorpusOnlyCategory', tags: ['CorpusOnlyTag'] },
      null,
    );
    f.store.memoryCatalog = async () => {
      throw new Error('Normal turns must not load the catalog');
    };
    for (const template of [
      '',
      'Custom instructions.',
      'Categories: {{categories}}; tags: {{tags}}',
    ]) {
      const process = new ProcessMessage(
        f.config,
        f.store,
        {
          async run(_session, _prompt, instructions) {
            assert(instructions.includes(f.config.memory.categories.slice(0, 12).join(', ')));
            assert(!instructions.includes('Configured12'));
            assert(!instructions.includes('CorpusOnly'));
            assert(!instructions.includes('{{'));
            assert.match(instructions, /memory_catalog only when/);
            assert.equal(instructions.split('Configured0').length, 2);
            return 'Answer';
          },
        },
        { enabled: false } as GooglePort,
        {} as TelegramPort,
        template,
      );
      assert.equal(
        (
          await process.execute(
            {
              id: 'catalog',
              session: 'owner',
              payload: { kind: 'chat', text: 'Hello' },
              status: 'running',
            },
            context,
          )
        ).output,
        'Answer',
      );
    }
  } finally {
    await f.close();
  }
});

test('catalog discovery is filtered, paginated, bounded and isolated to the selected profile', async () => {
  const f = await fixture();
  try {
    const tags = Array.from({ length: 75 }, (_, i) => `topic-${String(i).padStart(2, '0')}`);
    await f.store.insertMemory(
      'owner',
      { text: 'Owner fact', category: 'OwnerCategory', tags },
      null,
    );
    await f.store.insertMemory(
      'other',
      { text: 'Private fact', category: 'PrivateCategory', tags: ['private-topic'] },
      null,
    );
    const memory = new Memory(f.config.memory, f.store, {
      enabled: false,
      async embed() {
        return [];
      },
    });
    const tools = new Tools({ async audit() {} });
    registerMemoryTools(tools, memory);
    const discovered: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = (await tools.call(
        'memory_catalog',
        { kind: 'tags', search: 'TOPIC-', offset },
        context,
      )) as any;
      assert(tokens(page) <= TOOL_RESULT_TOKENS);
      assert.equal(page.total, tags.length);
      assert(page.items.length <= 20);
      discovered.push(...page.items);
      offset = page.next_offset;
    }
    assert.deepEqual(discovered, tags);
    const categories = (await tools.call('memory_catalog', { search: 'Category' }, context)) as any;
    assert.deepEqual(categories.items, ['OwnerCategory']);
    assert.deepEqual(
      ((await tools.call('memory_catalog', { kind: 'tags', search: 'private' }, context)) as any)
        .items,
      [],
    );
    f.config.memory.sharedProfile = 'owner';
    assert.deepEqual(
      (
        (await tools.call(
          'memory_catalog',
          { kind: 'tags', search: 'topic-74' },
          { ...context, session: 'other' },
        )) as any
      ).items,
      ['topic-74'],
    );
    await assert.rejects(() => tools.call('memory_catalog', { limit: 51 }, context));
  } finally {
    await f.close();
  }
});
