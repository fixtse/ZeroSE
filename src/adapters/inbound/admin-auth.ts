import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import { hashPassword } from 'better-auth/crypto';

function configure(pool: pg.Pool, origin: string, secret: string) {
  return betterAuth({
    database: pool,
    baseURL: origin,
    basePath: '/api/auth',
    secret: createHash('sha256')
      .update('assistant-admin-auth-v1:' + secret)
      .digest('hex'),
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    user: { modelName: 'admin_auth_user' },
    account: { modelName: 'admin_auth_account' },
    verification: { modelName: 'admin_auth_verification' },
    session: {
      modelName: 'admin_auth_session',
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60 * 24 * 30,
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'admin_auth_rate_limit',
      window: 60,
      max: 60,
      customRules: { '/sign-in/username': { window: 60, max: 5 } },
    },
    advanced: {
      cookiePrefix: 'fixt-admin',
      useSecureCookies: origin.startsWith('https:'),
      // initialize() migrates and validates the schema before requests can be served.
      database: { validateSchema: false },
    },
    plugins: [username({ immutableUsername: true })],
    logger: { level: 'error' },
  });
}

/** Browser administration uses a persistent, origin-checked session; API bearer access stays separate. */
export class AdminAuth {
  readonly auth: ReturnType<typeof configure>;
  readonly origin: string;
  constructor(
    private pool: pg.Pool,
    url: string,
    secret: string,
  ) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new Error('Invalid administrator URL');
    this.origin = target.origin;
    this.auth = configure(pool, this.origin, secret);
  }
  async initialize() {
    const { runMigrations } = await getMigrations(this.auth.options);
    await runMigrations();
    await this.auth.$context;
  }
  async provision(password: string, reset = false) {
    if (password.length < 12 || password.length > 128)
      throw new Error('Use a password with 12–128 characters');
    const hash = await hashPassword(password);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const previous = (
        await client.query('SELECT id FROM admin_auth_user WHERE username=$1', ['fixt'])
      ).rows[0];
      if (previous && !reset) throw new Error('The fixt administrator already exists');
      const id = previous?.id || randomUUID();
      if (!previous)
        await client.query(
          `INSERT INTO admin_auth_user(id,name,email,"emailVerified","createdAt","updatedAt",username,"displayUsername")
        VALUES($1,'fixt','fixt@assistant.invalid',true,now(),now(),'fixt','fixt')`,
          [id],
        );
      await client.query('DELETE FROM admin_auth_session WHERE "userId"=$1', [id]);
      await client.query('DELETE FROM admin_auth_account WHERE "userId"=$1 AND "providerId"=$2', [
        id,
        'credential',
      ]);
      await client.query(
        `INSERT INTO admin_auth_account(id,"userId","accountId","providerId",password,"createdAt","updatedAt") VALUES($1,$2,$2,'credential',$3,now(),now())`,
        [randomUUID(), id, hash],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (
      ![
        '/api/auth/sign-in/username',
        '/api/auth/get-session',
        '/api/auth/change-password',
        '/api/auth/sign-out',
      ].includes(path)
    ) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    await toNodeHandler(this.auth)(req, res);
  }
  async authorize(req: IncomingMessage, res: ServerResponse) {
    const result = await this.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    });
    const cookies = result.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    return result.response?.user.username === 'fixt';
  }
  mutationAllowed(req: IncomingMessage) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method || '')) return true;
    if (req.headers.origin === this.origin) return true;
    // The public panel may use a different origin from the configured auth URL.
    // Its custom header requires CORS preflight, which this server never permits,
    // so a cross-origin page cannot send an authenticated mutation this way.
    return req.headers['x-admin-request'] === '1' && req.headers['sec-fetch-site'] !== 'cross-site';
  }
}
