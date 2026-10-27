import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/application/memory.js';
import {
  MEMORY_SEARCH_TOKENS,
  TOOL_RESULT_TOKENS,
  tokens,
} from '../src/application/context-budget.js';
import { Tools } from '../src/application/tool-registry.js';
import {
  registerGoogleTools,
  registerHomeAssistantTools,
  registerMemoryTools,
} from '../src/adapters/inbound/integration-tools.js';
import type { GoogleToolsPort, HomeAssistantToolsPort } from '../src/application/ports.js';
import { fixture } from './helpers.js';
import { registerSearch } from '../src/adapters/outbound/search.js';
import { Store } from '../src/adapters/outbound/postgres-store.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';

const context = { session: 'owner', jobId: 'retrieval', signal: new AbortController().signal };

async function readPages(read: (offset: number) => Promise<any>) {
  let offset = 0,
    serialized = '',
    pages = 0;
  do {
    const page = await read(offset);
    assert(tokens(page) <= TOOL_RESULT_TOKENS);
    if (!pages && page.format !== 'json_fragment') return page;
    assert.equal(page.offset, offset);
    assert(!page.text.includes('\uFFFD'));
    serialized += page.text;
    pages++;
    if (page.next_offset === null) break;
    assert(page.next_offset > offset);
    offset = page.next_offset;
    assert(pages < 100);
  } while (true);
  return JSON.parse(serialized);
}

test('hybrid ranking combines lexical and vector evidence and preserves filters', async () => {
  const f = await fixture();
  try {
    await f.store.insertMemory(
      'owner',
      { text: 'General exercise advice', category: 'Ideas', tags: [] },
      [1, 0],
    );
    await f.store.insertMemory(
      'owner',
      { text: 'User discussed the project.', category: 'Ideas', tags: ['ZXQ731'] },
      [0, 1],
    );
    await f.store.insertMemory(
      'owner',
      { text: 'ZXQ731 project decision', category: 'Ideas', tags: [] },
      [1, 0],
    );
    await f.store.insertMemory(
      'owner',
      { text: 'ZXQ731 legacy memory', category: 'Other', tags: [] },
      null,
    );
    await f.store.insertMemory(
      'other',
      { text: 'ZXQ731 private memory', category: 'Ideas', tags: [] },
      [1, 0],
    );
    const found = await f.store.searchMemory('owner', 'ZXQ731', [1, 0], []);
    assert.equal(found[0].text, 'ZXQ731 project decision');
    assert(found.some((item) => item.metadata.tags.includes('ZXQ731')));
    assert(found.some((item) => item.text === 'ZXQ731 legacy memory'));
    assert(!found.some((item) => item.text.includes('private')));
    assert(
      (await f.store.searchMemory('owner', 'ZXQ731', [1, 0], ['Ideas'])).every(
        (item) => item.metadata.category === 'Ideas',
      ),
    );
    assert.deepEqual(await f.store.searchMemory('owner', 'ZXQ731', [1, 0], [], '2100-01-01'), []);
    assert.deepEqual(await f.store.searchMemory('owner', 'unrelatedword', undefined, []), []);
  } finally {
    await f.close();
  }
});

test('search is bounded and deduplicated without merging negations or attribution; reads remain profile-scoped', async () => {
  const f = await fixture();
  const tasks: string[] = [];
  try {
    const memory = new Memory(f.config.memory, f.store, {
      enabled: true,
      async embed(_text, type) {
        tasks.push(type);
        return [1, 0];
      },
    });
    for (const text of [
      'The user prefers the encrypted backups.',
      'USER prefers encrypted backups!',
      'The user does not prefer encrypted backups.',
      'The assistant recommends encrypted backups.',
    ])
      await memory.save('owner', { text, category: 'Ideas', tags: ['backups'] });
    const found = await memory.search('owner', 'backups');
    assert.equal(found.length, 3);
    assert(tokens(found) <= MEMORY_SEARCH_TOKENS);
    assert(found.some((item) => item.summary.includes('does not')));
    assert(found.some((item) => item.summary.includes('assistant')));
    assert.equal(tasks.at(-1), 'RETRIEVAL_QUERY');
    assert(tasks.slice(0, -1).every((type) => type === 'RETRIEVAL_DOCUMENT'));
    const tools = new Tools({ async audit() {} });
    registerMemoryTools(tools, memory);
    await assert.rejects(
      () => tools.call('memory_read', { memory_id: found[0].id }, { ...context, session: 'other' }),
      /not found/,
    );
    f.config.memory.sharedProfile = 'owner';
    assert.equal(((await memory.read('other', found[0].id)) as any).text, found[0].summary);
  } finally {
    await f.close();
  }
});

test('stored summaries and legacy excerpts support bounded lossless detail pages', async () => {
  const f = await fixture();
  try {
    const memory = new Memory(f.config.memory, f.store, {
      enabled: false,
      async embed() {
        throw new Error('disabled');
      },
    });
    const full =
      'The assistant suggested a backup plan, not an agreed user decision. ' +
      'Dates, qualifications and details 🛒 español 日本語. '.repeat(400);
    await memory.save('owner', {
      text: full,
      summary: 'The assistant suggested a backup plan; the user has not agreed.',
      category: 'Ideas',
      tags: [],
    });
    await memory.save('owner', {
      text: 'Legacy backups: ' + 'qualified details '.repeat(100),
      category: 'Ideas',
      tags: [],
    });
    const tools = new Tools({ async audit() {} });
    registerMemoryTools(tools, memory);
    const found = (await tools.call(
      'memories_get',
      { search_query: 'backup OR backups' },
      context,
    )) as any[];
    assert.equal(found.length, 2);
    assert(tokens(found) <= MEMORY_SEARCH_TOKENS);
    const short = found.find((item) => !item.summary_is_excerpt);
    assert.equal(short.summary, 'The assistant suggested a backup plan; the user has not agreed.');
    assert(found.find((item) => item.summary_is_excerpt).summary.includes('use memory_read'));
    const detail = await readPages((result_offset) =>
      tools.call('memory_read', { memory_id: short.id, result_offset }, context),
    );
    assert.equal(detail.text, full);
    await assert.rejects(
      () =>
        tools.call('memory_read', { memory_id: short.id, result_offset: full.length * 2 }, context),
      /offset/,
    );
  } finally {
    await f.close();
  }
});

test('explicit supersession hides outdated facts while preserving provenance and rolling back cross-profile replacements', async () => {
  const f = await fixture();
  try {
    const memory = new Memory(f.config.memory, f.store, {
      enabled: false,
      async embed() {
        return [];
      },
    });
    await memory.save('owner', { text: 'The user lives in Madrid.', category: 'Ideas', tags: [] });
    const old = (await memory.search('owner', 'Madrid'))[0];
    await assert.rejects(
      () =>
        memory.save('other', {
          text: 'The user lives in Barcelona.',
          category: 'Ideas',
          tags: [],
          supersedes: [old.id],
        }),
      /this profile/,
    );
    assert.equal((await memory.search('owner', 'Madrid')).length, 1);
    assert.deepEqual(await memory.search('other', 'Barcelona'), []);
    await memory.save(
      'owner',
      {
        text: 'The user confirmed moving to Barcelona.',
        category: 'Ideas',
        tags: [],
        supersedes: [old.id],
      },
      'replacement',
    );
    // A repeated consolidation source must not repeat replacement effects.
    await memory.save(
      'owner',
      {
        text: 'The user confirmed moving to Barcelona.',
        category: 'Ideas',
        tags: [],
        supersedes: [old.id],
      },
      'replacement',
    );
    assert.deepEqual(await memory.search('owner', 'Madrid'), []);
    const current = (await memory.search('owner', 'Barcelona'))[0];
    assert.equal(((await memory.read('owner', old.id)) as any).superseded_by, current.id);
    assert.equal(
      Number((await f.store.pool.query('SELECT count(*) FROM memories')).rows[0].count),
      2,
    );
  } finally {
    await f.close();
  }
});

test('integration lists paginate, details are lossless and writes return small receipts without replay', async () => {
  const records = Array.from({ length: 70 }, (_, i) => ({
    id: String(i),
    title: 'Task ' + i,
    status: 'needsAction',
    notes: 'Detailed notes 🛒 español 日本語. '.repeat(300),
    etag: 'omit',
  }));
  let writes = 0;
  const google = {
    enabled: true,
    async tasks() {
      return records;
    },
    async task(id: string) {
      return records.find((item) => item.id === id);
    },
    async createTask() {
      writes++;
      return records[0];
    },
    async events() {
      return records.map((item) => ({
        ...item,
        summary: item.title,
        description: item.notes,
        start: { date: '2026-10-16' },
        end: { date: '2026-10-17' },
      }));
    },
  } as unknown as GoogleToolsPort;
  const tools = new Tools({ async audit() {} });
  registerGoogleTools(tools, google);
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = (await tools.call('tasks_list', { offset }, context)) as any;
    assert(tokens(page) <= TOOL_RESULT_TOKENS);
    assert(page.items.length <= 20);
    assert(page.items.every((item: any) => !item.notes && !item.etag && item.details_available));
    ids.push(...page.items.map((item: any) => item.id));
    offset = page.next_offset;
  }
  assert.deepEqual(
    ids,
    records.map((item) => item.id),
  );
  const calendar = (await tools.call(
    'calendar_list',
    { start: '2026-10-16T00:00:00Z', end: '2026-10-17T00:00:00Z' },
    context,
  )) as any;
  assert(tokens(calendar) <= TOOL_RESULT_TOKENS);
  assert.equal(calendar.items[0].start.date, '2026-10-16');
  assert(!JSON.stringify(calendar).includes('Detailed notes'));
  const detail = await readPages((result_offset) =>
    tools.call('task_get', { task_id: '0', result_offset }, context),
  );
  assert.equal(detail.notes, records[0].notes);
  const receipt = (await tools.call('task_create', { title: 'Task 0' }, context)) as any;
  assert.equal(receipt.id, '0');
  assert(!receipt.notes);
  assert.equal(writes, 1);
});

test('sensor histories summarize available numeric samples and retain paginated raw observations', async () => {
  const samples = ['10', 'unknown', '20', 'unavailable', 'on', ''].map((state, i) => ({
    entity_id: 'sensor.temperature',
    state,
    last_changed: `2026-10-16T00:0${i}:00Z`,
  }));
  const ha = {
    async history() {
      return [samples];
    },
    async sensors() {
      return Array.from({ length: 100 }, (_, i) => ({
        entity_id: 'sensor.t' + i,
        state: 'unknown',
        attributes: {
          unit_of_measurement: '°C',
          friendly_name: 'Temperature',
          private_attribute: 'omit',
        },
      }));
    },
    async shopping() {
      return [
        {
          uid: 'one',
          summary: 'milk',
          status: 'needs_action',
          description: 'Important description 🛒 '.repeat(1000),
        },
      ];
    },
    async changeShopping() {
      return Array.from({ length: 200 }, () => ({ summary: 'omit' }));
    },
  } as unknown as HomeAssistantToolsPort;
  const tools = new Tools({ async audit() {} });
  registerHomeAssistantTools(
    tools,
    ha,
    ConfigSchema.parse({ homeAssistant: { token: 'test-only' } }).homeAssistant,
  );
  const args = {
    entity_id: 'sensor.temperature',
    start: '2026-10-16T00:00:00Z',
    end: '2026-10-17T00:00:00Z',
  };
  const summary = (await tools.call('sensor_history', args, context)) as any;
  assert.equal(summary.sample_count, 6);
  assert.equal(summary.numeric_samples, 2);
  assert.equal(summary.unavailable_samples, 3);
  assert.equal(summary.minimum, 10);
  assert.equal(summary.maximum, 20);
  assert.equal(summary.sample_mean, 15);
  assert(tokens(summary) <= TOOL_RESULT_TOKENS);
  const raw = (await tools.call(
    'sensor_history',
    { ...args, mode: 'raw', offset: 1, limit: 2 },
    context,
  )) as any;
  assert.deepEqual(raw.items, samples.slice(1, 3));
  assert.equal(raw.next_offset, 3);
  const sensors = (await tools.call('sensors_list', {}, context)) as any;
  assert(tokens(sensors) <= TOOL_RESULT_TOKENS);
  assert.equal(sensors.items[0].state, 'unknown');
  assert(!JSON.stringify(sensors).includes('private_attribute'));
  const shopping = await readPages((result_offset) =>
    tools.call('shopping_list_get', { result_offset }, context),
  );
  assert.equal(shopping.items[0].uid, 'one');
  assert.equal(shopping.items[0].description, 'Important description 🛒 '.repeat(1000));
  const receipt = await tools.call(
    'shopping_list_change',
    { operation: 'complete', item: 'one' },
    context,
  );
  assert.deepEqual(receipt, { verified: true, operation: 'complete' });
});

test('dense multilingual summaries obey the token budget and signed quantities are not deduplicated', async () => {
  const f = await fixture();
  try {
    const memory = new Memory(f.config.memory, f.store, {
      enabled: false,
      async embed() {
        return [];
      },
    });
    for (const number of [-5, 5, 15])
      await memory.save('owner', {
        text: `The user recorded a reading of ${number} degrees.`,
        summary: '🛒'.repeat(200),
        category: 'Ideas',
        tags: [],
      });
    const dense = await memory.search('owner', 'reading');
    assert(dense.length > 0 && dense.length < 3);
    assert(tokens(dense) <= MEMORY_SEARCH_TOKENS);
    await f.store.pool.query("UPDATE memories SET summary=NULL WHERE session='owner'");
    const distinct = await memory.search('owner', 'reading');
    assert.equal(distinct.length, 3);
    assert(distinct.some((item) => item.summary.includes('-5')));
    assert(distinct.some((item) => item.summary.includes('of 5')));
  } finally {
    await f.close();
  }
});

test('large image-search responses paginate without dropping source URLs and URL reads keep network restrictions', async (t) => {
  const image = {
    title: 'Detailed title 日本語 🛒 '.repeat(600),
    properties: { url: 'https://example.com/image.jpg' },
    url: 'https://example.com/source',
  };
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ results: [image] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const tools = new Tools({ async audit() {} });
  registerSearch(tools, 'test-only');
  const images = await readPages((result_offset) =>
    tools.call('image_search', { query: 'example', result_offset }, context),
  );
  assert.equal(images[0].title, image.title);
  assert.equal(images[0].source, image.url);
  assert.equal(images[0].url, image.properties.url);
  await assert.rejects(
    () => tools.call('url_read', { url: 'http://127.0.0.1/private' }, context),
    /public HTTPS/,
  );
});

test('schema drift is rejected without rewriting retained memory records', async () => {
  const f = await fixture();
  try {
    await f.store.insertMemory(
      'owner',
      { text: 'A legacy fact', category: 'Ideas', tags: [] },
      null,
    );
    await f.store.pool.query('ALTER TABLE memories DROP COLUMN summary, DROP COLUMN superseded_by');
    await f.store.close();
    await assert.rejects(Store.open(f.url, 2, f.schema), /schema mismatch.*missing column/i);
    const { default: pg } = await import('pg');
    const reader = new pg.Pool({ connectionString: f.url });
    try {
      const result = await reader.query(
        `SELECT text FROM ${f.schema}.memories WHERE session='owner'`,
      );
      assert.deepEqual(result.rows, [{ text: 'A legacy fact' }]);
    } finally {
      await reader.end();
    }
  } finally {
    await f.close();
  }
});
