import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GoogleConnection,
  googleScopes,
  requiredGoogleScopes,
  type GoogleOAuthPort,
} from '../src/application/google-connection.js';
import { GoogleOAuth } from '../src/adapters/outbound/google-oauth.js';
import { ConfigSchema } from '../src/adapters/outbound/config-schema.js';
import type { AccessProfile } from '../src/domain/access.js';

function setup() {
  const config = ConfigSchema.parse({});
  const profile: AccessProfile = {
    bot: 'zero',
    chatId: '123',
    label: 'Test',
    kind: 'user',
    enabled: true,
    owner: false,
    capabilities: ['calendar', 'tasks', 'documents'],
    google: {
      ...config.google,
      calendarId: 'kept-calendar',
      credentials: {
        calendar: { clientId: 'client', clientSecret: 'hidden-secret', refreshToken: 'old-token' },
      },
    },
  };
  let calls = 0,
    saves = 0,
    verified = false,
    now = 100;
  const oauth: GoogleOAuthPort = {
    authorizationUrl: (input) => new GoogleOAuth().authorizationUrl(input),
    async exchange(input) {
      calls++;
      assert.equal(input.clientSecret, 'hidden-secret');
      assert(input.verifier);
      return 'private-refresh';
    },
    async verify(google, scopes) {
      verified = true;
      assert.equal(google.refreshToken, 'private-refresh');
      assert.deepEqual(scopes, Object.values(googleScopes));
    },
  };
  const repository = {
    async profile() {
      return profile;
    },
    async replaceGoogleConnection(
      _bot: string,
      _chatId: string,
      expected: unknown,
      google: typeof config.google,
    ) {
      assert(verified);
      assert.deepEqual(expected, profile.google);
      saves++;
      profile.google = google;
      return true;
    },
  };
  const flow = new GoogleConnection(
    repository,
    oauth,
    'https://zero.example/v1/admin/google/oauth/callback',
    config.google,
    'google',
    () => now,
  );
  return {
    profile,
    flow,
    oauth,
    repository,
    config,
    calls: () => calls,
    saves: () => saves,
    expire: () => (now += 600_001),
  };
}

test('scope selection follows permitted tools and task provider, including owner fallback', () => {
  const f = setup();
  assert.deepEqual(requiredGoogleScopes(f.profile), Object.values(googleScopes));
  f.profile.homeAssistant = { ...f.config.homeAssistant, taskProvider: 'home_assistant' };
  assert(!requiredGoogleScopes(f.profile).includes(googleScopes.tasks));
  f.profile.capabilities = ['tasks'];
  assert.deepEqual(requiredGoogleScopes(f.profile), []);
  f.profile.homeAssistant = undefined;
  assert.deepEqual(requiredGoogleScopes(f.profile), [googleScopes.tasks]);
  f.profile.owner = true;
  assert.deepEqual(requiredGoogleScopes(f.profile, 'home_assistant'), []);
  f.profile.capabilities = ['web', 'homeAssistant'];
  assert.deepEqual(requiredGoogleScopes(f.profile), []);
});

test('authorization requests offline access, PKCE and selected scopes without secrets', async () => {
  const f = setup();
  f.profile.capabilities = ['calendar'];
  const url = new URL(await f.flow.begin('zero', '123', 'browser'));
  assert.equal(url.searchParams.get('scope'), googleScopes.calendar);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('include_granted_scopes'), null);
  assert(!url.toString().includes('hidden-secret'));
  assert(!url.toString().includes('old-token'));
});

test('only verified grants replace legacy credentials, preserving destinations; replay rejected', async () => {
  const f = setup();
  const url = new URL(await f.flow.begin('zero', '123', 'browser'));
  const state = url.searchParams.get('state')!;
  assert.equal((await f.flow.complete(state, 'browser', 'code', false)).status, 'connected');
  assert.equal(f.profile.google?.refreshToken, 'private-refresh');
  assert.equal(f.profile.google?.calendarId, 'kept-calendar');
  assert.deepEqual(f.profile.google?.credentials, {});
  await assert.rejects(() => f.flow.complete(state, 'browser', 'code', false));
  assert.equal(f.calls(), 1);
  assert.equal(f.saves(), 1);
});

for (const scenario of [
  'wrong-browser',
  'expired',
  'denied',
  'missing-code',
  'partial-grant',
  'exchange-failure',
  'tools-changed',
  'connection-changed',
] as const)
  test(`OAuth ${scenario} preserves existing grants`, async () => {
    const f = setup();
    const old = structuredClone(f.profile.google);
    const url = new URL(await f.flow.begin('zero', '123', 'browser'));
    const state = url.searchParams.get('state')!;
    if (scenario === 'expired') f.expire();
    if (scenario === 'partial-grant')
      f.oauth.verify = async () => {
        throw new Error('private-refresh');
      };
    if (scenario === 'exchange-failure')
      f.oauth.exchange = async () => {
        throw new Error('private-code');
      };
    if (scenario === 'tools-changed') f.profile.capabilities = ['calendar'];
    if (scenario === 'connection-changed') f.repository.replaceGoogleConnection = async () => false;
    const complete = () =>
      f.flow.complete(
        state,
        scenario === 'wrong-browser' ? 'other' : 'browser',
        scenario === 'missing-code' ? '' : 'code',
        scenario === 'denied',
      );
    if (scenario === 'wrong-browser' || scenario === 'expired') await assert.rejects(complete);
    else assert.notEqual((await complete()).status, 'connected');
    assert.deepEqual(f.profile.google, old);
    assert.equal(f.saves(), 0);
  });

test('unconfigured profile can authorize with supplied client; no Google tools cannot', async () => {
  const f = setup();
  f.profile.google = undefined;
  const url = new URL(await f.flow.begin('zero', '123', 'browser', 'new-client', 'new-secret'));
  assert.equal(url.searchParams.get('client_id'), 'new-client');
  f.profile.capabilities = ['tasks'];
  f.profile.homeAssistant = { ...f.config.homeAssistant, taskProvider: 'home_assistant' };
  await assert.rejects(() => f.flow.begin('zero', '123', 'browser', 'new-client', 'new-secret'));
});

test('Google adapter verifies refreshed token and calls only the selected APIs', async () => {
  const original = globalThis.fetch;
  const requests: { url: string; body: string }[] = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: String(options?.body || '') });
    return new Response(
      JSON.stringify(
        String(url).includes('/token')
          ? { access_token: 'hidden-access', scope: googleScopes.calendar }
          : {},
      ),
    );
  };
  try {
    const oauth = new GoogleOAuth();
    const config = ConfigSchema.parse({});
    await oauth.verify(
      { ...config.google, clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
      [googleScopes.calendar],
    );
    assert.equal(requests.length, 2);
    assert(requests[0].body.includes('grant_type=refresh_token'));
    assert(requests[1].url.includes('/calendar/'));
    await assert.rejects(() => oauth.verify(config.google, [googleScopes.tasks]));
  } finally {
    globalThis.fetch = original;
  }
});

test('Docs verification probes API availability for an empty account and rejects disabled APIs', async () => {
  const original = globalThis.fetch;
  let disabled = false;
  let docsCalls = 0;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/token'))
      return new Response(
        JSON.stringify({
          access_token: 'private-access',
          scope: [googleScopes.documents, googleScopes.drive].join(' '),
        }),
      );
    if (path.includes('docs.googleapis.com')) {
      docsCalls++;
      return new Response('{}', { status: disabled ? 403 : 404 });
    }
    return new Response(JSON.stringify({ files: [] }));
  };
  try {
    const oauth = new GoogleOAuth();
    const config = ConfigSchema.parse({});
    const scopes = [googleScopes.documents, googleScopes.drive];
    await oauth.verify(config.google, scopes);
    assert.equal(docsCalls, 1);
    disabled = true;
    await assert.rejects(() => oauth.verify(config.google, scopes));
  } finally {
    globalThis.fetch = original;
  }
});

test('authorization exchange never substitutes an access token for missing refresh token', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'private-access' }));
  try {
    await assert.rejects(() =>
      new GoogleOAuth().exchange({
        clientId: 'client',
        clientSecret: 'secret',
        verifier: 'verifier',
        redirectUri: 'https://zero.example/callback',
        code: 'code',
      }),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('Google connection CAS preserves unrelated credentials and rejects changed tools or connections', async () => {
  const { fixture } = await import('./helpers.js');
  const { PostgresAccess } = await import('../src/adapters/outbound/postgres-access.js');
  const f = await fixture();
  try {
    const repository = new PostgresAccess(f.store.db, f.config.apiKey);
    const p = setup().profile;
    p.homeAssistant = { ...f.config.homeAssistant, token: 'private-ha-token' };
    await repository.saveProfile(p);
    const scopes = requiredGoogleScopes(p);
    const expected = (await repository.profile(p.bot, p.chatId))!.google;
    const replacement = {
      ...f.config.google,
      clientId: 'client',
      clientSecret: 'private-client',
      refreshToken: 'private-refresh',
      credentials: {},
    };
    await repository.saveProfile({ ...p, capabilities: ['calendar'] });
    assert.equal(
      await repository.replaceGoogleConnection(
        p.bot,
        p.chatId,
        expected,
        replacement,
        scopes,
        'google',
      ),
      false,
    );
    await repository.saveProfile(p);
    assert.equal(
      await repository.replaceGoogleConnection(
        p.bot,
        p.chatId,
        expected,
        replacement,
        scopes,
        'google',
      ),
      true,
    );
    const saved = (await repository.profile(p.bot, p.chatId))!;
    assert.deepEqual(saved.google, replacement);
    assert.equal(saved.homeAssistant?.token, 'private-ha-token');
    assert.equal(
      await repository.replaceGoogleConnection(
        p.bot,
        p.chatId,
        expected,
        replacement,
        scopes,
        'google',
      ),
      false,
    );
    const encrypted = (
      await f.store.pool.query(
        'SELECT credentials FROM access_profiles WHERE bot=$1 AND chat_id=$2',
        [p.bot, p.chatId],
      )
    ).rows[0].credentials;
    assert(!encrypted.includes('private-refresh'));
    assert(!encrypted.includes('private-client'));
  } finally {
    await f.close();
  }
});
