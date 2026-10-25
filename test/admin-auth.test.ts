import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AdminAuth } from '../src/adapters/inbound/admin-auth.js';
import { Admin } from '../src/adapters/inbound/admin.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { Access } from '../src/application/access.js';
import { fixture } from './helpers.js';

const password = 'initial-password-for-test-only';
const nextPassword = 'updated-password-for-test-only';
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
async function setup() {
  const f = await fixture();
  f.config.telegram.allowedUsers = ['1'];
  const repository = new PostgresAccess(f.store.pool, f.config.apiKey);
  await repository.initialize(f.config);
  const management: { access: Access; admin: Admin; auth?: AdminAuth } = {
    access: new Access(repository, f.store),
    admin: new Admin(f.config, repository, async () => {}),
  };
  const server = createHttpServer(f.config, f.store, undefined, management);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const auth = new AdminAuth(f.store.pool, base, f.config.apiKey);
  await auth.initialize();
  await auth.provision(password);
  management.auth = auth;
  const post = (path: string, body: unknown, session = '') =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        ...(session ? { Cookie: session } : {}),
      },
      body: JSON.stringify(body),
    });
  return {
    f,
    repository,
    management,
    base,
    auth,
    post,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await f.close();
    },
  };
}

test('username login creates persistent sessions, renews them, survives restart, and preserves API bearer access', async () => {
  const s = await setup();
  try {
    assert.equal((await fetch(s.base + '/v1/admin/profiles')).status, 401);
    assert.equal(
      (await s.post('/api/auth/sign-in/username', { username: 'fixt', password: 'wrong' })).status,
      401,
    );
    const response = await s.post('/api/auth/sign-in/username', {
      username: 'fixt',
      password,
      rememberMe: true,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/i);
    assert.match(response.headers.get('set-cookie')!, /Max-Age=2592000/);
    const session = cookie(response);
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: session } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(s.base + '/v1/admin/profiles', {
          headers: { Authorization: `Bearer ${s.f.config.apiKey}` },
        })
      ).status,
      200,
    );
    await s.f.store.pool.query(
      'UPDATE admin_auth_session SET "updatedAt"=now()-interval \'2 days\',"expiresAt"=now()+interval \'1 day\'',
    );
    const renewal = await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: session } });
    assert.equal(renewal.status, 200);
    assert.match(renewal.headers.get('set-cookie')!, /Max-Age=2592000/);
    const replacement = new AdminAuth(s.f.store.pool, s.base, s.f.config.apiKey);
    await replacement.initialize();
    s.management.auth = replacement;
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: session } })).status,
      200,
    );
    assert.equal(
      (
        await s.post('/api/auth/sign-up/email', {
          email: 'intruder@example.com',
          password,
          name: 'Intruder',
        })
      ).status,
      404,
    );
    await assert.rejects(replacement.provision(nextPassword), /already exists/);
    const hashes = (await s.f.store.pool.query('SELECT password FROM admin_auth_account')).rows;
    assert.equal(hashes.length, 1);
    assert.notEqual(hashes[0].password, password);
    const secure = new AdminAuth(s.f.store.pool, 'https://admin.example.com', s.f.config.apiKey);
    assert.equal(secure.auth.options.advanced?.useSecureCookies, true);
  } finally {
    await s.close();
  }
});

test('password changes require the current password, keep the current browser signed in, and revoke other sessions', async () => {
  const s = await setup();
  try {
    const first = await s.post('/api/auth/sign-in/username', {
      username: 'fixt',
      password,
      rememberMe: true,
    });
    const second = await s.post('/api/auth/sign-in/username', {
      username: 'fixt',
      password,
      rememberMe: true,
    });
    const original = cookie(first),
      other = cookie(second);
    assert.equal(
      (
        await s.post(
          '/api/auth/change-password',
          { currentPassword: 'wrong', newPassword: nextPassword, revokeOtherSessions: true },
          original,
        )
      ).status,
      400,
    );
    const change = await s.post(
      '/api/auth/change-password',
      { currentPassword: password, newPassword: nextPassword, revokeOtherSessions: true },
      original,
    );
    assert.equal(change.status, 200);
    const current = cookie(change);
    assert(current);
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: current } })).status,
      200,
    );
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: other } })).status,
      401,
    );
    assert.equal(
      (await s.post('/api/auth/sign-in/username', { username: 'fixt', password })).status,
      401,
    );
    assert.equal(
      (await s.post('/api/auth/sign-in/username', { username: 'fixt', password: nextPassword }))
        .status,
      200,
    );
    assert.equal((await s.post('/api/auth/sign-out', {}, current)).status, 200);
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: current } })).status,
      401,
    );
  } finally {
    await s.close();
  }
});

test('profile deletion is origin-protected, revokes access, preserves history, and never reseeds a deleted owner', async () => {
  const s = await setup();
  const path = s.base + '/v1/admin/profiles/zero/1';
  try {
    const signed = await s.post('/api/auth/sign-in/username', {
      username: 'fixt',
      password,
      rememberMe: true,
    });
    const session = cookie(signed);
    await s.f.store.addMessage('telegram:1', 'user', 'Retained history');
    assert.equal(
      (await fetch(path, { method: 'DELETE', headers: { Cookie: session } })).status,
      403,
    );
    assert.equal(
      (
        await fetch(path, {
          method: 'DELETE',
          headers: { Cookie: session, Origin: 'https://evil.example.com' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(path, {
          method: 'DELETE',
          headers: {
            Cookie: session,
            Origin: 'https://panel.example.com',
            'X-Admin-Request': '1',
            'Sec-Fetch-Site': 'same-origin',
          },
        })
      ).status,
      200,
    );
    assert.equal(await s.repository.profile('zero', '1'), undefined);
    assert.match(JSON.stringify(await s.f.store.history('telegram:1')), /Retained history/);
    await s.repository.initialize(s.f.config);
    assert.equal(
      await s.repository.profile('zero', '1'),
      undefined,
      'Restart must not reauthorize a deleted seeded owner',
    );
    await s.management.access.receive('zero', {
      update_id: 100,
      message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'hello' },
    });
    assert.equal((await s.repository.profile('zero', '1'))?.enabled, false);
    assert.equal((await s.repository.profile('zero', '1'))?.owner, false);
  } finally {
    await s.close();
  }
});

test('login attempts are rate-limited in PostgreSQL', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await s.post('/api/auth/sign-in/username', { username: 'fixt', password: 'wrong' }))
          .status,
        401,
      );
    assert.equal(
      (await s.post('/api/auth/sign-in/username', { username: 'fixt', password })).status,
      429,
    );
    assert(
      (await s.f.store.pool.query('SELECT count(*) FROM admin_auth_rate_limit')).rows[0].count !==
        '0',
    );
  } finally {
    await s.close();
  }
});

test('Telegram recovery is opt-in, origin protected, limited, single-use and revokes sessions', async () => {
  const s = await setup();
  let code = '';
  try {
    const auth = new AdminAuth(s.f.store.pool, s.base, s.f.config.apiKey, {
      recipient: async () => '1',
      send: async (chat, value) => {
        assert.equal(chat, '1');
        code = value;
      },
    });
    await auth.initialize();
    s.management.auth = auth;
    const login = await s.post('/api/auth/sign-in/username', { username: 'fixt', password });
    const session = cookie(login);
    assert.equal((await s.post('/api/auth/recovery/settings', { enabled: true })).status, 401);
    assert.equal(
      (
        await fetch(s.base + '/api/auth/recovery/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
          body: JSON.stringify({ username: 'fixt' }),
        })
      ).status,
      403,
    );
    await s.post('/api/auth/recovery/request', { username: 'fixt' });
    assert.equal(code, '');
    assert.equal(
      (await s.post('/api/auth/recovery/settings', { enabled: true }, session)).status,
      200,
    );
    await s.f.store.pool.query(
      "UPDATE admin_password_recovery SET requested_at=now()-interval '2 minutes'",
    );
    assert.equal((await s.post('/api/auth/recovery/request', { username: 'fixt' })).status, 200);
    assert.match(code, /^[0-9]{8}$/);
    const row = (await s.f.store.pool.query('SELECT digest FROM admin_password_recovery')).rows[0];
    assert.notEqual(row.digest, code);
    assert.equal((await s.post('/api/auth/recovery/request', { username: 'fixt' })).status, 429);
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await s.post('/api/auth/recovery/reset', { code: '00000000', password: nextPassword }))
          .status,
        400,
      );
    assert.equal(
      (await s.post('/api/auth/recovery/reset', { code, password: nextPassword })).status,
      400,
    );
    await s.f.store.pool.query(
      "UPDATE admin_password_recovery SET requested_at=now()-interval '2 minutes'",
    );
    await s.post('/api/auth/recovery/request', { username: 'fixt' });
    await s.f.store.pool.query(
      "UPDATE admin_password_recovery SET expires_at=now()-interval '1 second'",
    );
    assert.equal(
      (await s.post('/api/auth/recovery/reset', { code, password: nextPassword })).status,
      400,
    );
    await s.f.store.pool.query(
      "UPDATE admin_password_recovery SET requested_at=now()-interval '2 minutes'",
    );
    await s.post('/api/auth/recovery/request', { username: 'fixt' });
    assert.equal(
      (await s.post('/api/auth/recovery/reset', { code, password: nextPassword })).status,
      200,
    );
    assert.equal(
      (await s.post('/api/auth/recovery/reset', { code, password: nextPassword })).status,
      400,
    );
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: session } })).status,
      401,
    );
    assert.equal(
      (await s.post('/api/auth/sign-in/username', { username: 'fixt', password: nextPassword }))
        .status,
      200,
    );
  } finally {
    await s.close();
  }
});

test('failed Telegram delivery invalidates the code without retrying', async () => {
  const s = await setup();
  let code = '',
    deliveries = 0;
  try {
    const auth = new AdminAuth(s.f.store.pool, s.base, s.f.config.apiKey, {
      recipient: async () => '1',
      send: async (_chat, value) => {
        code = value;
        deliveries++;
        throw new Error('uncertain delivery');
      },
    });
    await auth.initialize();
    s.management.auth = auth;
    const login = await s.post('/api/auth/sign-in/username', { username: 'fixt', password });
    await s.post('/api/auth/recovery/settings', { enabled: true }, cookie(login));
    assert.equal((await s.post('/api/auth/recovery/request', { username: 'fixt' })).status, 502);
    assert.equal(deliveries, 1);
    assert.equal(
      (await s.post('/api/auth/recovery/reset', { code, password: nextPassword })).status,
      400,
    );
    assert.equal((await s.post('/api/auth/recovery/request', { username: 'fixt' })).status, 429);
    assert.equal(deliveries, 1);
  } finally {
    await s.close();
  }
});
