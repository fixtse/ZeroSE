import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const { adminReadStaleTime, createAdminQueryClient }: typeof import('../web/lib/query-client.js') =
  createRequire(import.meta.url)('../web/lib/query-client.js');

test('admin cache allows scoped discovery but excludes credentials and live state', () => {
  for (const path of [
    '/v1/admin/setup/assistants?search=zero&offset=20',
    '/v1/admin/setup/assistants/zero',
    '/v1/admin/profiles/zero/123/entities?offset=20',
    '/v1/admin/profiles/zero/123/services',
    '/v1/admin/profiles/zero/123/google/calendars',
    '/v1/admin/profiles/zero/123/google/task-lists',
    '/v1/admin/profiles/zero/123/google/document-folders',
  ])
    assert.equal(adminReadStaleTime(path), 30_000, path);
  for (const path of [
    '/api/auth/get-session',
    '/v1/admin/setup/settings',
    '/v1/admin/setup/pairings/123',
    '/v1/admin/profiles',
    '/v1/admin/profiles/zero/123',
    '/v1/admin/profiles/zero/123/rules',
    '/v1/admin/ai',
    '/v1/admin/ai/models',
    '/v1/admin/setup/assistants/zero/credentials',
  ])
    assert.equal(adminReadStaleTime(path), undefined, path);
});

test('discovery cache deduplicates reads and isolates profiles, filters and pages', async () => {
  const client = createAdminQueryClient();
  let calls = 0;
  const read = (path: string) =>
    client.fetchQuery({
      queryKey: ['admin', path],
      queryFn: async () => ++calls,
    });
  try {
    assert.deepEqual(
      await Promise.all([read('/entities?offset=0'), read('/entities?offset=0')]),
      [1, 1],
    );
    assert.equal(await read('/entities?offset=0'), 1);
    assert.equal(await read('/entities?offset=20'), 2);
    assert.equal(await read('/entities?offset=0&search=todo'), 3);
    assert.equal(await read('/other-profile/entities?offset=0'), 4);
    client.clear();
    assert.equal(await read('/entities?offset=0'), 5);
  } finally {
    client.clear();
  }
});

test('failed reads are not retried and clearing cancels pending reads', async (t) => {
  const client = createAdminQueryClient();
  let calls = 0;
  try {
    await assert.rejects(
      client.fetchQuery({
        queryKey: ['admin', 'failure'],
        queryFn: async () => {
          calls++;
          throw new Error('offline');
        },
      }),
      /offline/,
    );
    assert.equal(calls, 1);
    let signal: AbortSignal | undefined;
    let finish!: (value: string) => void;
    const pending = client.fetchQuery({
      queryKey: ['admin', 'pending'],
      queryFn: (context) => {
        signal = context.signal;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    });
    const pendingQuery = client.getQueryCache().find({ queryKey: ['admin', 'pending'] });
    assert(pendingQuery);
    t.after(async () => {
      // Cancellation can schedule GC after clear() detaches the query from the cache.
      await pending.catch(() => {});
      pendingQuery.destroy();
    });
    const rejected = assert.rejects(pending);
    client.clear();
    assert.equal(signal?.aborted, true);
    finish('old session');
    await rejected;
    assert.equal(client.getQueryData(['admin', 'pending']), undefined);
  } finally {
    client.clear();
  }
});
