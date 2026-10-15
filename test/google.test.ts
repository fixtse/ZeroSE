import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Google } from '../src/adapters/outbound/google.js';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
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
