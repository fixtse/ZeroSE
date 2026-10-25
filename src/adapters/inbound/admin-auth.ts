import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
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
    private secret: string,
    private recovery?: {
      recipient: () => Promise<string | undefined>;
      send: (chat: string, code: string) => Promise<void>;
    },
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
    await this.pool.query(`CREATE TABLE IF NOT EXISTS admin_password_recovery (
      id integer PRIMARY KEY CHECK (id=1), enabled boolean NOT NULL DEFAULT false,
      digest text, recipient text, expires_at timestamptz, requested_at timestamptz,
      attempts integer NOT NULL DEFAULT 0
    )`);
    await this.pool.query(
      'INSERT INTO admin_password_recovery(id) VALUES(1) ON CONFLICT DO NOTHING',
    );
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
      await client.query('UPDATE admin_password_recovery SET digest=NULL WHERE id=1');
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
    if (path.startsWith('/api/auth/recovery/')) {
      await this.handleRecovery(req, res, path.slice('/api/auth/recovery/'.length));
      return;
    }
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
  private digest(code: string) {
    return createHmac('sha256', this.secret)
      .update('admin-recovery:' + code)
      .digest('hex');
  }
  private async handleRecovery(req: IncomingMessage, res: ServerResponse, action: string) {
    const send = (status: number, message: string, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ message, ...extra }));
    };
    if (!['settings', 'request', 'reset'].includes(action)) return send(404, 'Not found');
    if (action === 'settings') {
      if (!(await this.authorize(req, res))) return send(401, 'Inicia sesión.');
    }
    if (req.method === 'GET' && action === 'settings') {
      const row = (await this.pool.query('SELECT enabled FROM admin_password_recovery WHERE id=1'))
        .rows[0];
      return send(200, '', {
        enabled: row.enabled,
        available: !!(await this.recovery?.recipient()),
      });
    }
    if (req.method !== 'POST') return send(405, 'Método no permitido.');
    if (!this.mutationAllowed(req)) return send(403, 'Origen no permitido.');
    let input: Record<string, unknown>;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) return send(413, 'Solicitud demasiado grande.');
      }
      input = JSON.parse(body);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    } catch {
      return send(400, 'Solicitud no válida.');
    }
    if (action === 'settings') {
      if (typeof input.enabled !== 'boolean') return send(400, 'Configuración no válida.');
      if (input.enabled && !(await this.recovery?.recipient()))
        return send(400, 'Configura el propietario privado de Telegram de Zero.');
      await this.pool.query(
        'UPDATE admin_password_recovery SET enabled=$1,digest=NULL WHERE id=1',
        [input.enabled],
      );
      return send(200, 'Configuración guardada.');
    }
    if (
      action === 'reset' &&
      (typeof input.password !== 'string' ||
        input.password.length < 12 ||
        input.password.length > 128 ||
        typeof input.code !== 'string' ||
        !/^\d{8}$/.test(input.code))
    )
      return send(400, 'Usa un código de 8 cifras y una contraseña de 12–128 caracteres.');
    const client = await this.pool.connect();
    let delivery: { chat: string; code: string } | undefined;
    try {
      await client.query('BEGIN');
      const row = (
        await client.query(
          'SELECT *, now() AS current_time FROM admin_password_recovery WHERE id=1 FOR UPDATE',
        )
      ).rows[0];
      const recipient = await this.recovery?.recipient();
      if (action === 'request') {
        if (row.requested_at && row.current_time - row.requested_at < 60000) {
          await client.query('ROLLBACK');
          return send(429, 'Espera un minuto antes de solicitar otro código.');
        }
        const code = String(randomInt(10000000, 100000000));
        const active = row.enabled && recipient && input.username === 'fixt';
        await client.query(
          "UPDATE admin_password_recovery SET requested_at=now(),digest=$1,recipient=$2,expires_at=now()+interval '10 minutes',attempts=0 WHERE id=1",
          [active ? this.digest(code) : null, active ? recipient : null],
        );
        if (active) delivery = { chat: recipient, code };
      } else {
        const digest = this.digest(input.code as string);
        const valid =
          row.enabled &&
          row.digest &&
          row.recipient === recipient &&
          row.expires_at > row.current_time &&
          row.attempts < 5 &&
          timingSafeEqual(Buffer.from(row.digest), Buffer.from(digest));
        await client.query(
          'UPDATE admin_password_recovery SET attempts=LEAST(attempts+1,5) WHERE id=1',
        );
        if (!valid) {
          await client.query('COMMIT');
          return send(400, 'Código incorrecto, caducado o agotado.');
        }
        const hash = await hashPassword(input.password as string);
        await client.query(
          `UPDATE admin_auth_account SET password=$1,"updatedAt"=now() WHERE "providerId"='credential' AND "userId" IN (SELECT id FROM admin_auth_user WHERE username='fixt')`,
          [hash],
        );
        await client.query(
          `DELETE FROM admin_auth_session WHERE "userId" IN (SELECT id FROM admin_auth_user WHERE username='fixt')`,
        );
        await client.query('UPDATE admin_password_recovery SET digest=NULL WHERE id=1');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (delivery) {
      try {
        await this.recovery!.send(delivery.chat, delivery.code);
      } catch {
        await this.pool.query(
          'UPDATE admin_password_recovery SET digest=NULL WHERE id=1 AND digest=$1',
          [this.digest(delivery.code)],
        );
        return send(
          502,
          'No se pudo confirmar el envío. No se ha reintentado; espera un minuto antes de solicitar otro código.',
        );
      }
    }
    return send(
      200,
      action === 'request'
        ? 'Si la recuperación está activada, recibirás un código en el Telegram del administrador.'
        : 'Contraseña actualizada. Inicia sesión de nuevo.',
    );
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
