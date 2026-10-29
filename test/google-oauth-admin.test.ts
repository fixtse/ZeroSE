import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GoogleConnection } from '../src/application/google-connection.js';
import { GoogleOAuth } from '../src/adapters/outbound/google-oauth.js';
import {
  GoogleOAuthAdmin,
  googleCallbackPath,
} from '../src/adapters/inbound/google-oauth-admin.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import type { AccessProfile } from '../src/domain/access.js';

function setup(redirectOrigin = 'https://zero.example', adminOrigin?: string) {
  const config = ConfigSchema.parse({});
  const profile: AccessProfile = {
    bot: 'zero',
    chatId: '123',
    label: 'Test',
    owner: false,
    enabled: true,
    kind: 'user',
    capabilities: ['calendar'],
    google: { ...config.google, clientId: 'client', clientSecret: 'private-secret' },
  };
  let exchanged = 0;
  const oauth = new GoogleOAuth();
  oauth.exchange = async () => {
    exchanged++;
    return 'private-refresh';
  };
  oauth.verify = async () => {};
  const admin = new GoogleOAuthAdmin(
    new GoogleConnection(
      {
        async profile() {
          return profile;
        },
        async replaceGoogleConnection(_bot, _chat, _expected, google) {
          profile.google = google;
          return true;
        },
      },
      oauth,
      redirectOrigin + googleCallbackPath,
      config.google,
    ),
    adminOrigin,
  );
  async function request(
    url: string,
    method: string,
    body: unknown = {},
    cookie = '',
    origin?: string,
  ) {
    const headers: Record<string, unknown> = { 'Set-Cookie': ['existing-auth-cookie'] };
    let status = 0;
    let value: any;
    const res = {
      getHeader(name: string) {
        return headers[name];
      },
      setHeader(name: string, value: unknown) {
        headers[name] = value;
      },
      writeHead(code: number, value: unknown) {
        status = code;
        Object.assign(headers, value);
      },
      end() {},
    } as unknown as ServerResponse;
    const handled = await admin.handle(
      { method, url, headers: { cookie, origin } } as IncomingMessage,
      res,
      url.split('?')[0],
      async () => body,
      (code, result) => {
        status = code;
        value = result;
      },
    );
    return { handled, status, value, headers };
  }
  return { request, profile, admin, exchanged: () => exchanged };
}

test('OAuth HTTP flow sets a browser binding, preserves auth cookies and returns no tokens', async () => {
  const f = setup();
  const path = '/v1/admin/profiles/zero/123/google/oauth';
  assert.equal(
    (await f.request(path, 'GET')).value.redirectUri,
    'https://zero.example' + googleCallbackPath,
  );
  const start = await f.request(path, 'POST');
  assert.equal(start.status, 200);
  const cookies = start.headers['Set-Cookie'] as string[];
  assert.equal(cookies[0], 'existing-auth-cookie');
  assert(cookies[1].includes('HttpOnly; SameSite=Lax; Path=/; Max-Age=600; Secure'));
  assert(!JSON.stringify(start.value).includes('private-'));
  const state = new URL(start.value.authorizationUrl).searchParams.get('state');
  const callback =
    googleCallbackPath + '?' + new URLSearchParams({ state: state!, code: 'private-code' });
  assert.equal((await f.request(callback, 'GET')).status, 400);
  assert.equal(f.exchanged(), 0);
  const result = await f.request(
    callback,
    'GET',
    {},
    'fixt-admin.session_token=existing-session; ' + cookies[1].split(';')[0],
  );
  assert.equal(result.status, 303);
  assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
  assert(String(result.headers.Location).includes('googleOAuth=connected'));
  assert(!JSON.stringify(result.headers).includes('private-'));
  assert.equal(f.exchanged(), 1);
  assert.equal((await f.request(callback, 'GET', {}, cookies[1].split(';')[0])).status, 400);
});

test('OAuth refusal leaves credentials untouched', async () => {
  const f = setup();
  const old = structuredClone(f.profile.google);
  const start = await f.request('/v1/admin/profiles/zero/123/google/oauth', 'POST');
  const state = new URL(start.value.authorizationUrl).searchParams.get('state')!;
  const cookie = (start.headers['Set-Cookie'] as string[])[1].split(';')[0];
  const result = await f.request(
    googleCallbackPath + '?' + new URLSearchParams({ state, error: 'access_denied' }),
    'GET',
    {},
    cookie,
  );
  assert.equal(result.status, 303);
  assert(String(result.headers.Location).includes('cancelled'));
  assert.deepEqual(f.profile.google, old);
  assert.equal(f.exchanged(), 0);
});

test('HTTP initiation requires admin authorization; callback only accepts state bound to browser', async () => {
  const { once } = await import('node:events');
  const { fixture } = await import('./helpers.js');
  const { PostgresAccess } = await import('../src/adapters/outbound/postgres-access.js');
  const { Access } = await import('../src/application/access.js');
  const { Admin } = await import('../src/adapters/inbound/admin.js');
  const { createHttpServer } = await import('../src/adapters/inbound/http-server.js');
  const f = await fixture();
  const flow = setup();
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  const server = createHttpServer(f.config, f.store, undefined, {
    access: new Access(repository, f.store),
    admin: new Admin(f.config, repository, async () => {}),
    googleOAuth: flow.admin,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    const path = '/v1/admin/profiles/zero/123/google/oauth';
    assert.equal((await fetch(base + path, { method: 'POST', body: '{}' })).status, 401);
    const start = await fetch(base + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + f.config.apiKey },
      body: '{}',
    });
    assert.equal(start.status, 200);
    const { authorizationUrl } = await start.json();
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const callback =
      base + googleCallbackPath + '?' + new URLSearchParams({ state, code: 'private-code' });
    assert.equal((await fetch(callback, { redirect: 'manual' })).status, 400);
    const completed = await fetch(callback, {
      redirect: 'manual',
      headers: {
        Cookie:
          'fixt-admin.session_token=existing-session; ' +
          start.headers.getSetCookie()[0].split(';')[0],
      },
    });
    assert.equal(completed.status, 303);
    assert(!completed.headers.get('Location')?.includes('private-code'));
    assert.equal((await fetch(base + path)).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('browser readiness check detects blocked cookies without consuming authorization', async () => {
  const f = setup();
  const path = '/v1/admin/profiles/zero/123/google/oauth';
  const start = await f.request(path, 'POST');
  const state = new URL(start.value.authorizationUrl).searchParams.get('state')!;
  const cookie =
    'fixt-admin.session_token=existing-session; ' +
    (start.headers['Set-Cookie'] as string[])[1].split(';')[0];
  const missing = await f.request(path + '/check', 'POST', { state });
  assert.equal(missing.status, 400);
  assert.equal(missing.value.code, 'browser_missing');
  assert.equal((await f.request(path + '/check', 'POST', { state }, cookie)).value.ready, true);
  assert.equal((await f.request(path + '/check', 'POST', { state }, cookie)).status, 200);
  assert.equal(f.exchanged(), 0);
  const cancelled = await f.request(
    googleCallbackPath + '?' + new URLSearchParams({ state, error: 'access_denied' }),
    'GET',
    {},
    cookie,
  );
  assert.equal(cancelled.status, 303);
  assert.equal(
    (await f.request(path + '/check', 'POST', { state }, cookie)).value.code,
    'state_missing',
  );
});

test('OAuth begins only on the configured origin, even when generic admin access permits aliases', async () => {
  const f = setup();
  const path = '/v1/admin/profiles/zero/123/google/oauth';
  const alias = await f.request(path, 'POST', {}, '', 'http://localhost:8788');
  assert.equal(alias.status, 400);
  assert.equal(alias.value.code, 'origin_mismatch');
  assert(!alias.headers['Set-Cookie'] || (alias.headers['Set-Cookie'] as string[]).length === 1);
  assert(alias.value.error.includes('https://zero.example/admin/'));
  assert.equal((await f.request(path, 'POST', {}, '', 'https://zero.example')).status, 200);
});

test('callback errors distinguish missing cookies, invalid parameters and missing state safely', async () => {
  const f = setup();
  const path = '/v1/admin/profiles/zero/123/google/oauth';
  const start = await f.request(path, 'POST');
  const state = new URL(start.value.authorizationUrl).searchParams.get('state')!;
  const cookie = (start.headers['Set-Cookie'] as string[])[1].split(';')[0];
  assert.equal(
    (await f.request(googleCallbackPath + '?code=private-code', 'GET', {}, cookie)).value.code,
    'invalid_callback',
  );
  const callback = googleCallbackPath + '?' + new URLSearchParams({ state, code: 'private-code' });
  const result = await f.request(callback, 'GET');
  assert.equal(result.value.code, 'browser_missing');
  assert(!JSON.stringify(result).includes('private-code'));
  const unknown = await f.request(
    googleCallbackPath + '?' + new URLSearchParams({ state: 'x'.repeat(43), code: 'private-code' }),
    'GET',
    {},
    cookie,
  );
  assert.equal(unknown.value.code, 'state_missing');
});

test('relay redirect URI keeps initiation and cookie binding at the Zero admin origin', async () => {
  const f = setup('https://ha.example/api/assistant_zero/relay/entry', 'https://zero.example');
  const path = '/v1/admin/profiles/zero/123/google/oauth';
  const details = await f.request(path, 'GET');
  assert.equal(details.value.adminOrigin, 'https://zero.example');
  assert.equal(
    details.value.redirectUri,
    'https://ha.example/api/assistant_zero/relay/entry' + googleCallbackPath,
  );
  const started = await f.request(path, 'POST', {}, '', 'https://zero.example');
  assert.equal(started.status, 200);
  const state = new URL(started.value.authorizationUrl).searchParams.get('state')!;
  const cookies = started.headers['Set-Cookie'] as string[];
  const cookie = cookies
    .find((value) => value.startsWith('__Host-zero-google-oauth='))!
    .split(';')[0];
  const callback = await f.request(
    googleCallbackPath + '?' + new URLSearchParams({ state, code: 'relay-code' }),
    'GET',
    {},
    cookie,
  );
  assert.equal(callback.status, 303);
  assert.equal(f.exchanged(), 1);
  assert.equal((await f.request(path, 'POST', {}, '', 'https://ha.example')).status, 400);
});
