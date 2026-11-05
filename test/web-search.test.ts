import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSearch } from '../src/adapters/outbound/search.js';
import { Tools } from '../src/application/tool-registry.js';
import { modelAllowsApplicationTool } from '../src/domain/ai-tools.js';
import { toolCapability } from '../src/domain/access.js';
import { tokens, TOOL_RESULT_TOKENS } from '../src/application/context-budget.js';

const context = (jobId: string) => ({
  session: 'test-web-session',
  jobId,
  signal: new AbortController().signal,
});
function toolsFor(model: string | undefined, webAllowed = true, key = 'test-brave-key') {
  const tools = new Tools(
    { async audit() {} },
    async (name) =>
      modelAllowsApplicationTool(model, name) && (webAllowed || toolCapability(name) !== 'web'),
    (name) =>
      modelAllowsApplicationTool(model, name) && (webAllowed || toolCapability(name) !== 'web'),
  );
  registerSearch(tools, key);
  return tools;
}

test('Brave web search uses the saved key and bounded page, language and freshness filters', async (t) => {
  let requests = 0;
  const item = {
    title: 'Source title',
    url: 'https://example.com/source',
    description: 'A useful excerpt.',
  };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.search.brave.com');
    assert.equal(url.pathname, '/res/v1/web/search');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      q: 'tiempo en Madrid',
      count: '3',
      offset: '2',
      result_filter: 'web',
      safesearch: 'moderate',
      search_lang: 'es',
      country: 'ES',
      freshness: 'pw',
    });
    assert.equal(new Headers(init?.headers).get('X-Subscription-Token'), 'test-brave-key');
    assert.equal(init?.redirect, 'error');
    assert(init?.signal);
    return Response.json({ query: { more_results_available: true }, web: { results: [item] } });
  });
  const tools = toolsFor('claude-sonnet');
  const result = await tools.call(
    'web_search',
    {
      query: 'tiempo en Madrid',
      page: 2,
      limit: 3,
      language: 'es',
      country: 'ES',
      freshness: 'pw',
    },
    context('request-filters'),
  );
  assert.deepEqual(result, { items: [item], page: 2, next_page: 3 });
  assert.equal(requests, 1);
  assert(!JSON.stringify(result).includes('test-brave-key'));
});

test('web lookup respects model rules, profile permissions and absence of a Brave key', async () => {
  assert.equal(toolCapability('web_search'), 'web');
  const names = (tools: Tools) =>
    tools
      .definitions()
      .map((tool) => tool.name)
      .sort();
  assert.deepEqual(names(toolsFor('gpt-5.1-codex')), ['image_search']);
  assert.deepEqual(names(toolsFor('openai/gpt-6')), ['image_search']);
  assert.deepEqual(names(toolsFor('gpt-4.1')), ['image_search', 'url_read', 'web_search']);
  assert.deepEqual(names(toolsFor(undefined)), ['image_search', 'url_read', 'web_search']);
  assert.deepEqual(names(toolsFor('claude-sonnet', false)), []);
  assert.deepEqual(names(toolsFor('claude-sonnet', true, '')), ['url_read']);
  await assert.rejects(
    toolsFor('gpt-5').call('web_search', { query: 'test' }, context('denied')),
    /not permitted/,
  );
  await assert.rejects(
    toolsFor('claude-sonnet', false).call(
      'web_search',
      { query: 'test' },
      context('denied-permission'),
    ),
    /not permitted/,
  );
});

test('search query and pagination validation rejects oversized requests before contacting Brave', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({});
  });
  const tools = toolsFor('gpt-4.1');
  for (const args of [
    { query: '' },
    { query: 'x'.repeat(601) },
    { query: 'word '.repeat(76) },
    { query: 'test', limit: 21 },
    { query: 'test', page: 10 },
    { query: 'test', page: -1 },
  ])
    await assert.rejects(tools.call('web_search', args, context('invalid-request')));
  assert.equal(requests, 0);
});

test.skip('large web search pages retain source links within the result budget without repeating paid searches', async (t) => {
  let requests = 0;
  const item = {
    title: 'Source',
    url: 'https://example.com/full-page',
    description: '日本語'.repeat(1800),
  };
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ query: { more_results_available: false }, web: { results: [item] } });
  });
  const current = context('fragment-snapshot');
  const tools = toolsFor('claude-sonnet');
  let offset = 0,
    serialized = '';
  for (let page = 0; page < 50; page++) {
    const result = (await tools.call(
      'web_search',
      { query: 'large response', result_offset: offset },
      current,
    )) as {
      format: string;
      text: string;
      next_offset: number | null;
    };
    assert.equal(result.format, 'json_fragment');
    assert(tokens(result) <= TOOL_RESULT_TOKENS);
    serialized += result.text;
    if (result.next_offset === null) break;
    offset = result.next_offset;
  }
  assert.deepEqual(JSON.parse(serialized), { items: [item], page: 0, next_page: null });
  assert.equal(requests, 1);
  await assert.rejects(
    tools.call(
      'web_search',
      { query: 'large response', result_offset: 1 },
      context('different-job'),
    ),
    /Search page expired/,
  );
  assert.equal(requests, 1, 'A missing scoped snapshot must not trigger another search');
});

test('empty results and the last provider page terminate search pagination', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return requests === 1
      ? Response.json({ query: { more_results_available: true } })
      : Response.json({
          query: { more_results_available: true },
          web: { results: [{ title: 'Last hit', url: 'https://example.com' }] },
        });
  });
  const tools = toolsFor('gpt-4.1');
  assert.deepEqual(await tools.call('web_search', { query: 'no results' }, context('empty')), {
    items: [],
    page: 0,
    next_page: null,
  });
  assert.deepEqual(
    await tools.call('web_search', { query: 'last page', page: 9 }, context('last')),
    {
      items: [{ title: 'Last hit', url: 'https://example.com', description: '' }],
      page: 9,
      next_page: null,
    },
  );
});

test('Brave failures are surfaced without retrying or exposing the saved key', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response('', { status: 429 });
  });
  await assert.rejects(
    toolsFor('gpt-4.1').call('web_search', { query: 'rate limit' }, context('failure')),
    {
      message: 'Brave Web Search returned HTTP 429',
    },
  );
  assert.equal(requests, 1);
});

test('oversized Brave responses are rejected by the download limit', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('{}', {
        headers: { 'Content-Length': '1000001' },
      }),
  );
  await assert.rejects(
    toolsFor('gpt-4.1').call('web_search', { query: 'large' }, context('body-limit')),
    /size limit/,
  );
});

test('image search spaces concurrent requests and reuses scoped results without paid fragment reads', async (t) => {
  const starts: number[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    starts.push(Date.now());
    assert(init?.signal);
    return Response.json({
      results: [
        {
          title: 'Device',
          properties: { url: 'https://example.com/device.png' },
          url: 'https://example.com/device',
        },
      ],
    });
  });
  const tools = toolsFor('gpt-4.1');
  const current = context('image-cache');
  const args = { query: 'exact device model' };
  const [first, duplicate] = await Promise.all([
    tools.call('image_search', args, current),
    tools.call('image_search', args, current),
    tools.call('image_search', { query: 'another device' }, current),
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal(starts.length, 2);
  assert(starts[1] - starts[0] >= 1000);
  await tools.call('image_search', args, current);
  assert.equal(starts.length, 2);
  await assert.rejects(
    tools.call('image_search', { ...args, result_offset: 1 }, context('other-image-job')),
    /Image search page expired/,
  );
  assert.equal(starts.length, 2);
});

test('aborted queued image searches do not reach Brave or poison the queue', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ results: [] });
  });
  const tools = toolsFor('gpt-4.1');
  await tools.call('image_search', { query: 'first' }, context('image-abort'));
  const controller = new AbortController();
  const pending = tools.call(
    'image_search',
    { query: 'cancelled' },
    { ...context('image-abort'), signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending);
  assert.equal(requests, 1);
  await tools.call('image_search', { query: 'next' }, context('image-abort'));
  assert.equal(requests, 2);
});

test('image search rejects oversized responses and never retries provider failures', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return requests === 1
      ? new Response('', { status: 429 })
      : new Response('{}', { headers: { 'Content-Length': '1000001' } });
  });
  const tools = toolsFor('gpt-4.1');
  await assert.rejects(
    tools.call('image_search', { query: 'limited' }, context('image-failure')),
    /Brave Image Search returned HTTP 429/,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    tools.call('image_search', { query: 'oversized' }, context('image-failure')),
    /size limit/,
  );
  assert.equal(requests, 2);
});
