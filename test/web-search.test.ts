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
function toolsFor(model: string | undefined, webAllowed = true, key = 'test-brave-key', imageSettings?: Parameters<typeof registerSearch>[3]) {
  const tools = new Tools(
    { async audit() {} },
    async (name) =>
      modelAllowsApplicationTool(model, name) && (webAllowed || toolCapability(name) !== 'web'),
    (name) =>
      modelAllowsApplicationTool(model, name) && (webAllowed || toolCapability(name) !== 'web'),
  );
  registerSearch(tools, key, undefined, imageSettings);
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
  assert.deepEqual(names(toolsFor('gpt-5.1-codex')), ['image_search', 'image_search_providers']);
  assert.deepEqual(names(toolsFor('openai/gpt-6')), ['image_search', 'image_search_providers']);
  assert.deepEqual(names(toolsFor('gpt-4.1')), ['image_search', 'image_search_providers', 'url_read', 'web_search']);
  assert.deepEqual(names(toolsFor(undefined)), ['image_search', 'image_search_providers', 'url_read', 'web_search']);
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

test('image provider discovery is credential-free and respects the web permission', async () => {
  const settings = { defaultProvider: 'searchapi' as const, searchApiKey: 'private-searchapi-key', serpApiKey: 'private-serpapi-key' };
  const tools = toolsFor('gpt-6', true, '', settings);
  assert.deepEqual(tools.definitions().map(x => x.name).sort(), ['image_search', 'image_search_providers']);
  const catalog = await tools.call('image_search_providers', {}, context('image-catalog'));
  assert.deepEqual(catalog, { default_provider: 'searchapi', items: [
    { id: 'searchapi', name: 'SearchAPI Google Images', native_size_filter: true, native_transparency_filter: true },
    { id: 'serpapi', name: 'SerpApi Google Images', native_size_filter: true, native_transparency_filter: true },
  ] });
  assert(!JSON.stringify(catalog).includes('private-'));
  assert.equal(toolCapability('image_search_providers'), 'web');
  await assert.rejects(toolsFor('gpt-6', false, '', settings).call('image_search_providers', {}, context('image-denied')), /not permitted/);
});

for (const provider of ['searchapi', 'serpapi'] as const) {
  test(`${provider} applies native filters, returns original dimensions, and never falls back on failure`, async (t) => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests++;
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('q'), 'SONOFF Dongle Max');
      assert.equal(url.searchParams.get('engine'), 'google_images');
      assert.equal(init?.redirect, 'error');
      assert(init?.signal);
      if (provider === 'searchapi') {
        assert.equal(url.origin, 'https://www.searchapi.io');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer searchapi-private-key');
        assert.equal(url.searchParams.get('color'), 'transparent');
        assert.equal(url.searchParams.get('size'), 'large');
      } else {
        assert.equal(url.origin, 'https://serpapi.com');
        assert.equal(url.searchParams.get('api_key'), 'serpapi-private-key');
        assert.equal(url.searchParams.get('image_color'), 'trans');
        assert.equal(url.searchParams.get('imgsz'), 'l');
      }
      if (requests > 1) return new Response('', { status: 429 });
      const item = provider === 'searchapi'
        ? { title: 'Exact model', original: { link: 'https://example.com/full.png', width: 1600, height: 1200 }, source: { link: 'https://example.com/product' }, thumbnail: 'https://example.com/tiny.jpg' }
        : { title: 'Exact model', original: 'https://example.com/full.png', original_width: 1600, original_height: 1200, link: 'https://example.com/product', thumbnail: 'https://example.com/tiny.jpg' };
      return Response.json(provider === 'searchapi' ? { images: [item] } : { images_results: [item] });
    });
    const tools = toolsFor('gpt-6', true, 'brave-private-key', { defaultProvider: provider, searchApiKey: 'searchapi-private-key', serpApiKey: 'serpapi-private-key' });
    const args = { query: 'SONOFF Dongle Max', transparent: true, size: 'large', limit: 10 };
    const result = await tools.call('image_search', args, context('provider-image'));
    assert.deepEqual(result, [{ title: 'Exact model', url: 'https://example.com/full.png', source: 'https://example.com/product', width: 1600, height: 1200, provider }]);
    assert(!JSON.stringify(result).includes('private-key'));
    assert.deepEqual(await tools.call('image_search', args, context('provider-image')), result);
    assert.equal(requests, 1);
    await assert.rejects(tools.call('image_search', args, context('provider-failure')), /HTTP 429/);
    assert.equal(requests, 2, 'No fallback or automatic retry may contact another provider');
  });
}

test('provider selection is explicit, unavailable keys fail before requests, and fragments reuse a scoped snapshot', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ images: Array.from({ length: 20 }, (_, i) => ({ title: `${i} ` + '元'.repeat(950), original: { link: `https://example.com/${i}.png`, width: 2000, height: 2000 }, source: { link: 'https://example.com/product' } })) });
  });
  const tools = toolsFor('gpt-6', true, '', { defaultProvider: 'brave', searchApiKey: 'search-key', serpApiKey: '' });
  await assert.rejects(tools.call('image_search', { query: 'default missing' }, context('missing-default')), /not configured/);
  await assert.rejects(tools.call('image_search', { query: 'missing', provider: 'serpapi' }, context('missing-provider')), /not configured/);
  assert.equal(requests, 0);
  const args = { query: 'large response', provider: 'searchapi', limit: 20 };
  let offset = 0, serialized = '';
  for (let page = 0; page < 100; page++) {
    const fragment = await tools.call('image_search', { ...args, result_offset: offset }, context('image-fragments')) as { text: string; next_offset: number | null };
    assert(tokens(fragment) <= TOOL_RESULT_TOKENS);
    serialized += fragment.text;
    if (fragment.next_offset === null) break;
    offset = fragment.next_offset;
  }
  const result = JSON.parse(serialized);
  assert.equal(result.length, 20);
  assert.equal(result[19].url, 'https://example.com/19.png');
  assert.equal(requests, 1);
  await assert.rejects(tools.call('image_search', { ...args, result_offset: 1 }, context('different-image-job')), /page expired/);
  assert.equal(requests, 1);
});

test('provider error bodies are redacted, results are bounded, and image request validation precedes fetch', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ error: 'private-provider-key' }); });
  const tools = toolsFor('gpt-6', true, '', { defaultProvider: 'searchapi', searchApiKey: 'private-provider-key', serpApiKey: '' });
  for (const args of [{ query: '' }, { query: 'x'.repeat(401) }, { query: 'word '.repeat(51) }, { query: 'test', limit: 21 }])
    await assert.rejects(tools.call('image_search', args, context('invalid-image')));
  assert.equal(requests, 0);
  await assert.rejects(tools.call('image_search', { query: 'valid' }, context('error-image')), error => error instanceof Error && !error.message.includes('private-provider-key') && /search failed/.test(error.message));
  assert.equal(requests, 1);
});
