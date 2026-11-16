import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenFoodFacts } from '../src/adapters/outbound/open-food-facts.js';

test('catalog encodes search and preserves barcode leading zeros', async () => {
  const urls: URL[] = [];
  const catalog = new OpenFoodFacts(async (input) => {
    urls.push(new URL(String(input)));
    return new Response(JSON.stringify({ products: [] }), { status: 200 });
  });
  await catalog.search('milk & oats', 2, 5);
  assert.equal(urls[0]?.searchParams.get('search_terms'), 'milk & oats');
  assert.equal(urls[0]?.searchParams.get('page'), '2');
  assert.equal(urls[0]?.searchParams.get('page_size'), '5');
  await catalog.barcode('001234567890');
  assert.equal(urls[1]?.pathname, '/api/v2/product/001234567890.json');
});

test('catalog surfaces upstream failures instead of returning invented products', async () => {
  const catalog = new OpenFoodFacts(async () => new Response('', { status: 429 }));
  await assert.rejects(catalog.search('milk', 1, 5), /HTTP 429/);
});
