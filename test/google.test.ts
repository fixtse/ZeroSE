import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Google } from '../src/adapters/outbound/google.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
test('Google scopes stay separate and Docs uses its own API host', async () => {
  const original = globalThis.fetch,
    requests: {
      url: string;
      body: string;
    }[] = [];
  globalThis.fetch = async (url: any, options: any) => {
    requests.push({ url: String(url), body: String(options.body || '') });
    if (String(url).includes('oauth2.googleapis.com'))
      return new Response(JSON.stringify({ access_token: 'test', expires_in: 3600 }));
    if (String(url).includes('docs.googleapis.com'))
      return new Response(
        JSON.stringify({
          body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Context' } }] } }] },
        }),
      );
    return new Response(JSON.stringify({ items: [] }));
  };
  try {
    const config = ConfigSchema.parse({
      google: {
        contextDocumentId: 'document',
        credentials: {
          docs: { clientId: 'docs-id', clientSecret: 'test', refreshToken: 'docs-refresh' },
          tasks: { clientId: 'tasks-id', clientSecret: 'test', refreshToken: 'tasks-refresh' },
        },
      },
    });
    const google = new Google(config.google, config.timezone);
    assert.equal(await google.context(), 'Context');
    await google.tasks();
    assert(
      requests.some(
        (request) => request.url === 'https://docs.googleapis.com/v1/documents/document',
      ),
    );
    assert(requests.some((request) => request.body.includes('docs-refresh')));
    assert(requests.some((request) => request.body.includes('tasks-refresh')));
  } finally {
    globalThis.fetch = original;
  }
});

test('Google destination discovery bounds pages and uses service-specific endpoints', async () => {
  const config = ConfigSchema.parse({});
  const google = new Google(config.google, config.timezone);
  const requests: string[] = [];
  google.request = async (url: string) => {
    requests.push(url);
    return url.startsWith('drive/')
      ? {
          files: [
            { id: 'folder', name: 'Documents', capabilities: { canAddChildren: true } },
            { id: 'readonly', name: 'Read only', capabilities: { canAddChildren: false } },
          ],
          nextPageToken: 'next',
        }
      : {
          items: [
            { id: 'chosen', summary: 'Personal', title: 'Personal' },
            { id: 'other', summary: 'Other', title: 'Other' },
          ],
          nextPageToken: 'next',
        };
  };
  const signal = AbortSignal.timeout(1000);
  const query = { search: 'Personal', limit: 20, pageToken: 'page' };
  assert.deepEqual(await google.destinations('calendars', query, signal), {
    items: [{ id: 'chosen', name: 'Personal' }],
    nextPageToken: 'next',
  });
  await google.destinations('task-lists', query, signal);
  assert.deepEqual(
    await google.destinations('document-folders', { ...query, search: "O'Brien" }, signal),
    { items: [{ id: 'folder', name: 'Documents' }], nextPageToken: 'next' },
  );
  assert(requests[0].startsWith('calendar/v3/users/me/calendarList?'));
  assert(requests[1].startsWith('tasks/v1/users/@me/lists?'));
  const params = new URLSearchParams(requests[2].split('?')[1]);
  assert.equal(params.get('pageSize'), '20');
  assert.equal(params.get('pageToken'), 'page');
  assert(params.get('q')?.includes("O\\'Brien"));
});
