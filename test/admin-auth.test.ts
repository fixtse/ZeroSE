import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
async function setup(provision = true) {
  const f = await fixture();
  f.config.telegram.allowedUsers = ['1'];
  const repository = new PostgresAccess(f.store.db, f.config.apiKey);
  await repository.initialize(f.config);
  const management: { access: Access; admin: Admin; auth?: AdminAuth } = {
    access: new Access(repository, f.store),
    admin: new Admin(f.config, repository, async () => {}),
  };
  const server = createHttpServer(f.config, f.store, undefined, management);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const auth = new AdminAuth(f.store.db, base, f.config.apiKey);
  await auth.initialize();
  if (provision) await auth.provision(password, false, 'fixt');
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
    const replacement = new AdminAuth(s.f.store.db, s.base, s.f.config.apiKey);
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
    await assert.rejects(replacement.provision(nextPassword, false, 'fixt'), /already exists/);
    const hashes = (await s.f.store.pool.query('SELECT password FROM admin_auth_account')).rows;
    assert.equal(hashes.length, 1);
    assert.notEqual(hashes[0].password, password);
    const secure = new AdminAuth(s.f.store.db, 'https://admin.example.com', s.f.config.apiKey);
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

test('Telegram recovery is available by default, origin protected, limited, single-use and revokes sessions', async () => {
  const s = await setup();
  let code = '';
  try {
    const auth = new AdminAuth(s.f.store.db, s.base, s.f.config.apiKey, {
      recipient: async () => '1',
      send: async (chat, value) => {
        assert.equal(chat, '1');
        code = value;
      },
    });
    // Existing installations no longer need their old recovery opt-in.
    await s.f.store.pool.query(
      'ALTER TABLE admin_password_recovery ADD COLUMN enabled boolean NOT NULL DEFAULT false',
    );
    await auth.initialize();
    s.management.auth = auth;
    const login = await s.post('/api/auth/sign-in/username', { username: 'fixt', password });
    const session = cookie(login);
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
    const auth = new AdminAuth(s.f.store.db, s.base, s.f.config.apiKey, {
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

function totp(uri: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const secret = new URL(uri).searchParams.get('secret')!;
  let bits = '';
  for (const char of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(char.toUpperCase()).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((value) => parseInt(value, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

test('2FA enrollment, username challenge and single-use backup codes preserve the session boundary', async () => {
  const s = await setup();
  try {
    const login = () => s.post('/api/auth/sign-in/username', { username: 'fixt', password });
    const session = cookie(await login());
    const enrollment = await s.post('/api/auth/two-factor/enable', { password }, session);
    assert.equal(enrollment.status, 200);
    const { totpURI, backupCodes } = (await enrollment.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    assert.ok(totpURI.startsWith('otpauth://'));
    assert.ok(backupCodes.length > 0);
    const invalid = await s.post('/api/auth/two-factor/verify-totp', { code: 'invalid' }, session);
    assert.notEqual(invalid.status, 200);
    const confirmation = await s.post(
      '/api/auth/two-factor/verify-totp',
      { code: totp(totpURI) },
      session,
    );
    assert.equal(confirmation.status, 200);
    const challenge = await login();
    assert.equal(
      ((await challenge.json()) as { twoFactorRedirect: boolean }).twoFactorRedirect,
      true,
    );
    const pending = cookie(challenge);
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: pending } })).status,
      401,
    );
    const verified = await s.post(
      '/api/auth/two-factor/verify-backup-code',
      { code: backupCodes[0] },
      pending,
    );
    assert.equal(verified.status, 200);
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: cookie(verified) } }))
        .status,
      200,
    );
    const nextChallenge = await login();
    assert.notEqual(
      (
        await s.post(
          '/api/auth/two-factor/verify-backup-code',
          { code: backupCodes[0] },
          cookie(nextChallenge),
        )
      ).status,
      200,
    );
    const disabled = await s.post('/api/auth/two-factor/disable', { password }, cookie(verified));
    assert.equal(disabled.status, 200);
    assert.equal((await login()).status, 200);
  } finally {
    await s.close();
  }
});

test('passkey registration requires a session and uses the configured relying party', async () => {
  const s = await setup();
  try {
    const path = '/api/auth/passkey/generate-register-options';
    assert.equal((await fetch(s.base + path)).status, 401);
    const session = cookie(
      await s.post('/api/auth/sign-in/username', { username: 'fixt', password }),
    );
    const options = await fetch(s.base + path, { headers: { Cookie: session } });
    assert.equal(options.status, 200);
    const value = (await options.json()) as { rp: { id: string; name: string } };
    assert.equal(value.rp.id, '127.0.0.1');
    assert.equal(value.rp.name, 'Zero');
    const invalid = await s.post(
      '/api/auth/passkey/verify-registration',
      { response: {} },
      session,
    );
    assert.notEqual(invalid.status, 200);
    const listed = await fetch(s.base + '/api/auth/passkey/list-user-passkeys', {
      headers: { Cookie: session },
    });
    assert.deepEqual(await listed.json(), []);
    assert.equal((await s.post('/api/auth/sign-up/email', {})).status, 404);
  } finally {
    await s.close();
  }
});

test('first-run setup creates a chosen administrator once, signs in, and survives restart', async () => {
  const s = await setup(false);
  try {
    assert.deepEqual(await (await fetch(s.base + '/api/auth/setup')).json(), {
      setupRequired: true,
      ingress: false,
      authenticated: false,
    });
    assert.equal(
      (
        await fetch(s.base + '/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
          body: JSON.stringify({ username: 'alice', password }),
        })
      ).status,
      403,
    );
    assert.equal(
      (await s.post('/api/auth/setup', { username: 'alice', password: 'short' })).status,
      400,
    );
    const attempts = await Promise.all(
      ['alice', 'bob'].map((username) => s.post('/api/auth/setup', { username, password })),
    );
    assert.equal(attempts.filter((result) => result.status === 201).length, 1);
    assert.equal((await s.f.store.pool.query('SELECT id FROM admin_auth_user')).rowCount, 1);
    const username = attempts[0].status === 201 ? 'alice' : 'bob';
    const login = await s.post('/api/auth/sign-in/username', { username, password });
    assert.equal(login.status, 200);
    const session = cookie(login);
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: session } })).status,
      200,
    );
    const state = await (
      await fetch(s.base + '/api/auth/setup', { headers: { Cookie: session } })
    ).json();
    assert.equal(state.authenticated, true);
    assert.equal(state.setupRequired, false);
    assert.equal((await s.post('/api/auth/setup', { username: 'charlie', password })).status, 409);
    const restarted = new AdminAuth(s.f.store.db, s.base, s.f.config.apiKey);
    await restarted.initialize();
    assert.equal(
      await restarted.authorize({ headers: { cookie: session } } as any, { setHeader() {} } as any),
      true,
    );
  } finally {
    await s.close();
  }
});

test('Ingress trusts only the Supervisor peer, checks HA admin status, and blocks local bootstrap', async () => {
  const s = await setup(false);
  try {
    let admin = true;
    let calls = 0;
    const auth = new AdminAuth(s.f.store.db, s.base, s.f.config.apiKey, undefined, {
      enabled: true,
      async isAdministrator(id) {
        calls++;
        assert.equal(id, 'a'.repeat(32));
        return admin;
      },
    });
    s.management.auth = auth;
    const request = (
      peer: string,
      id: string | undefined = 'a'.repeat(32),
      path = '/api/hassio_ingress/token',
    ) =>
      ({
        socket: { remoteAddress: peer },
        headers: { 'x-remote-user-id': id, 'x-ingress-path': path },
      }) as any;
    const response = { setHeader() {} } as any;
    assert.equal(await auth.authorize(request('127.0.0.1'), response), false);
    assert.equal(calls, 0);
    assert.equal(await auth.authorize(request('172.30.32.2', ''), response), false);
    assert.equal(
      await auth.authorize(request('172.30.32.2', undefined, '//evil.example'), response),
      false,
    );
    assert.equal(await auth.authorize(request('172.30.32.2'), response), true);
    assert.equal(await auth.authorize(request('::ffff:172.30.32.2'), response), true);
    admin = false;
    assert.equal(await auth.authorize(request('172.30.32.2'), response), false);
    assert.equal((await s.post('/api/auth/setup', { username: 'alice', password })).status, 403);
    assert.equal(
      (await s.post('/api/auth/sign-in/username', { username: 'fixt', password })).status,
      403,
    );
    assert.equal((await fetch(s.base + '/api/auth/get-session')).status, 403);
    const state = await (await fetch(s.base + '/api/auth/setup')).json();
    assert.equal(state.setupRequired, false);
    assert.equal(state.ingress, true);
  } finally {
    await s.close();
  }
});

test('recovery targets the chosen administrator username rather than a fixed account', async () => {
  const s = await setup(false);
  let code = '';
  try {
    assert.equal(
      (await s.post('/api/auth/setup', { username: 'alice-admin', password })).status,
      201,
    );
    const auth = new AdminAuth(s.f.store.db, s.base, s.f.config.apiKey, {
      recipient: async () => '1',
      send: async (_chat, value) => {
        code = value;
      },
    });
    await auth.initialize();
    s.management.auth = auth;
    const login = await s.post('/api/auth/sign-in/username', { username: 'alice-admin', password });
    assert.equal(login.status, 200);
    const session = cookie(login);
    assert.equal(
      (await s.post('/api/auth/recovery/request', { username: 'alice-admin' })).status,
      200,
    );
    assert.match(code, /^\d{8}$/);
    assert.equal(
      (await s.post('/api/auth/recovery/reset', { code, password: nextPassword })).status,
      200,
    );
    assert.equal(
      (
        await s.post('/api/auth/sign-in/username', {
          username: 'alice-admin',
          password: nextPassword,
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: session } })).status,
      401,
    );
  } finally {
    await s.close();
  }
});

test('automatic recovery prefers Telegram, uses only existing HA account links, and otherwise needs the console', async () => {
  const s = await setup();
  let telegramAvailable = true;
  let telegramSends = 0;
  let mobileReads = 0;
  let failTelegram = false;
  try {
    const auth = new AdminAuth(
      s.f.store.db,
      s.base,
      s.f.config.apiKey,
      {
        recipient: async () => (telegramAvailable ? '1' : undefined),
        send: async () => {
          telegramSends++;
          if (failTelegram) throw new Error('Uncertain');
        },
      },
      undefined,
      {
        targets: async () => {
          mobileReads++;
          return ['mobile_app_phone'];
        },
        send: async () => {
          throw new Error('Unexpected mobile delivery');
        },
      },
    );
    await auth.initialize();
    s.management.auth = auth;
    const cooldown = () =>
      s.f.store.pool.query(
        "UPDATE admin_password_recovery SET requested_at=now()-interval '2 minutes'",
      );
    const request = () => s.post('/api/auth/recovery/request', { username: 'fixt' });
    assert.equal((await request()).status, 200);
    assert.equal(telegramSends, 1);
    assert.equal(mobileReads, 0);
    await s.f.store.pool.query(
      `INSERT INTO admin_mobile_recovery(user_id,profile_chat_id,ha_user_id,verified_at)
      SELECT id,$1,$2,now() FROM admin_auth_user WHERE username='fixt'`,
      ['ha:' + 'a'.repeat(32), 'a'.repeat(32)],
    );
    await cooldown();
    assert.equal((await request()).status, 200);
    assert.equal(telegramSends, 2);
    assert.equal(mobileReads, 0, 'Telegram takes priority even for a linked HA user');
    failTelegram = true;
    await cooldown();
    assert.equal((await request()).status, 502);
    assert.equal(mobileReads, 0, 'An uncertain Telegram send must not trigger mobile delivery');
    telegramAvailable = false;
    await s.f.store.pool.query('DELETE FROM admin_mobile_recovery');
    await cooldown();
    assert.equal((await request()).status, 200);
    assert.equal(mobileReads, 0, 'An unlinked account cannot use HA');
    assert.equal(
      (await s.f.store.pool.query('SELECT digest FROM admin_password_recovery')).rows[0].digest,
      null,
    );
    assert.equal(
      (await s.post('/api/auth/recovery/reset', { code: '12345678', password: nextPassword }))
        .status,
      400,
    );
    await cooldown();
    assert.equal((await s.post('/api/auth/recovery/request', { username: 'unknown' })).status, 200);
    assert.equal(telegramSends, 3, 'Unknown accounts do not send notifications');
    assert.equal((await s.post('/api/auth/recovery/mobile/configure', {})).status, 404);
    assert.equal((await s.post('/api/auth/recovery/mobile/confirm', {})).status, 404);
  } finally {
    await s.close();
  }
});

test('HA recovery resolves all current devices on demand, binds the account and invalidates changed destinations', async () => {
  const s = await setup(false);
  const profile = 'ha:' + 'a'.repeat(32);
  let targets = ['mobile_app_phone', 'mobile_app_tablet'];
  let connected = true;
  let failSend = false;
  const deliveries: { targets: string[]; code: string }[] = [];
  try {
    await s.post('/api/auth/setup', { username: 'alice', password });
    const auth = new AdminAuth(s.f.store.db, s.base, s.f.config.apiKey, undefined, undefined, {
      targets: async (chat, user) => {
        assert.equal(chat, profile);
        assert.equal(user, 'a'.repeat(32));
        if (!connected) throw new Error('Revoked connection');
        return [...targets];
      },
      send: async (chat, user, current, code) => {
        assert.equal(chat, profile);
        assert.equal(user, 'a'.repeat(32));
        deliveries.push({ targets: [...current], code });
        if (failSend) throw new Error('Uncertain delivery');
      },
    });
    await auth.initialize();
    s.management.auth = auth;
    await s.f.store.pool.query(
      `INSERT INTO admin_mobile_recovery(user_id,profile_chat_id,ha_user_id,service,verified_at)
      SELECT id,$1,$2,'notify.mobile_app_old_phone',now() FROM admin_auth_user WHERE username='alice'`,
      [profile, 'a'.repeat(32)],
    );
    assert.equal(deliveries.length, 0, 'No startup or enrollment notification');
    const session = cookie(
      await s.post('/api/auth/sign-in/username', { username: 'alice', password }),
    );
    const cooldown = () =>
      s.f.store.pool.query(
        "UPDATE admin_password_recovery SET requested_at=now()-interval '2 minutes'",
      );
    const request = () => s.post('/api/auth/recovery/request', { username: 'alice' });
    const reset = (code: string) =>
      s.post('/api/auth/recovery/reset', { code, password: nextPassword });
    assert.equal((await request()).status, 200);
    assert.deepEqual(deliveries[0].targets, ['mobile_app_phone', 'mobile_app_tablet']);
    assert.notEqual(
      (await s.f.store.pool.query('SELECT digest FROM admin_password_recovery')).rows[0].digest,
      deliveries[0].code,
    );
    targets = ['mobile_app_replacement', 'mobile_app_tablet'];
    assert.equal(
      (await reset(deliveries[0].code)).status,
      400,
      'Removing a device invalidates its outstanding code',
    );
    await cooldown();
    assert.equal((await request()).status, 200);
    assert.deepEqual(deliveries[1].targets, targets, 'The saved legacy phone is ignored');
    assert.equal((await reset(deliveries[1].code)).status, 200);
    assert.equal((await reset(deliveries[1].code)).status, 400, 'Reset codes remain single-use');
    assert.equal(
      (await fetch(s.base + '/v1/admin/profiles', { headers: { Cookie: session } })).status,
      401,
    );
    assert.equal(
      (await s.post('/api/auth/sign-in/username', { username: 'alice', password: nextPassword }))
        .status,
      200,
    );
    connected = false;
    await cooldown();
    assert.equal((await request()).status, 200);
    assert.equal(deliveries.length, 2);
    connected = true;
    targets = [];
    await cooldown();
    assert.equal((await request()).status, 200);
    assert.equal(deliveries.length, 2);
    targets = ['mobile_app_new_phone'];
    failSend = true;
    await cooldown();
    assert.equal((await request()).status, 502);
    assert.equal(deliveries.length, 3);
    assert.equal((await reset(deliveries[2].code)).status, 400);
    assert.equal((await request()).status, 429);
    assert.equal(deliveries.length, 3, 'Never replay an uncertain send');
  } finally {
    await s.close();
  }
});
