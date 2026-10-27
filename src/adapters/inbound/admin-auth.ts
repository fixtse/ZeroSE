import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import {
  admin_auth_user as users,
  admin_auth_account as accounts,
  admin_auth_session as sessions,
  passwordRecovery as recovery,
} from '../outbound/auth-schema.js';
import { execute, type Database } from '../outbound/database.js';
import type { MobileRecoveryPort } from '../../application/mobile-recovery.js';
import { MobileRecoveryAdmin } from './mobile-recovery-admin.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import * as authSchema from '../outbound/auth-schema.js';
import { passkey } from '@better-auth/passkey';
import { username, twoFactor } from 'better-auth/plugins';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { hashPassword } from 'better-auth/crypto';

function configure(db: Database, origin: string, secret: string) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema, transaction: true }),
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
      // The versioned database migration runs before authentication is composed.
      database: { validateSchema: true },
    },
    plugins: [
      username({
        immutableUsername: true,
        minUsernameLength: 3,
        maxUsernameLength: 32,
        usernameValidator: (value) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,31}$/.test(value),
      }),
      twoFactor({ issuer: 'Zero', schema: { twoFactor: { modelName: 'admin_auth_two_factor' } } }),
      passkey({
        rpID: new URL(origin).hostname,
        rpName: 'Zero',
        origin,
        schema: { passkey: { modelName: 'admin_auth_passkey' } },
      }),
    ],
    logger: { level: 'error' },
  });
}

/** Browser administration uses a persistent, origin-checked session; API bearer access stays separate. */
export class AdminAuth {
  readonly auth: ReturnType<typeof configure>;
  readonly origin: string;
  private mobile?: MobileRecoveryAdmin;
  constructor(
    private db: Database,
    url: string,
    private secret: string,
    private recovery?: {
      recipient: () => Promise<string | undefined>;
      send: (chat: string, code: string) => Promise<void>;
    },
    private ingress?: { enabled: boolean; isAdministrator: (id: string) => Promise<boolean> },
    mobile?: MobileRecoveryPort,
  ) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new Error('Invalid administrator URL');
    this.origin = target.origin;
    if (mobile) this.mobile = new MobileRecoveryAdmin(db, mobile);
    this.auth = configure(db, this.origin, secret);
  }
  async initialize() {
    await this.auth.$context;
    await this.db.insert(recovery).values({ id: 1 }).onConflictDoNothing();
    await this.mobile?.initialize();
  }
  async provision(password: string, reset = false, username: string, initial = false) {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,31}$/.test(username))
      throw new Error(
        'Usa un usuario de 3–32 caracteres: letras, números, punto, guion o guion bajo.',
      );
    username = username.toLowerCase();
    if (password.length < 12 || password.length > 128)
      throw new Error('Use a password with 12–128 characters');
    const hash = await hashPassword(password);
    await this.db.transaction(async (client) => {
      await execute(client, sql`LOCK TABLE admin_auth_user IN EXCLUSIVE MODE`);
      if (initial && (await client.select({ id: users.id }).from(users).limit(1)).length)
        throw new Error('La configuración inicial ya se ha completado.');
      const [previous] = await client
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username));
      if (previous && !reset) throw new Error('The administrator already exists');
      const id = previous?.id || randomUUID();
      if (!previous)
        await client.insert(users).values({
          id,
          name: username,
          email: username + '@assistant.invalid',
          emailVerified: true,
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
          username,
          displayUsername: username,
        });
      await client.delete(sessions).where(eq(sessions.userId, id));
      await client
        .delete(accounts)
        .where(and(eq(accounts.userId, id), eq(accounts.providerId, 'credential')));
      await client.insert(accounts).values({
        id: randomUUID(),
        userId: id,
        accountId: id,
        providerId: 'credential',
        password: hash,
        createdAt: sql`now()`,
        updatedAt: sql`now()`,
      });
      await client.update(recovery).set({ digest: null }).where(eq(recovery.id, 1));
    });
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (path === '/api/auth/setup') {
      await this.handleSetup(req, res);
      return;
    }
    if (this.ingress?.enabled) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'La autenticación se gestiona en Home Assistant.' }));
      return;
    }
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
        '/api/auth/two-factor/enable',
        '/api/auth/two-factor/disable',
        '/api/auth/two-factor/verify-totp',
        '/api/auth/two-factor/verify-backup-code',
        '/api/auth/passkey/generate-register-options',
        '/api/auth/passkey/verify-registration',
        '/api/auth/passkey/generate-authenticate-options',
        '/api/auth/passkey/verify-authentication',
        '/api/auth/passkey/list-user-passkeys',
        '/api/auth/passkey/delete-passkey',
      ].includes(path)
    ) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    await toNodeHandler(this.auth)(req, res);
  }
  ingressPath(req: IncomingMessage) {
    if (
      !this.ingress?.enabled ||
      !['172.30.32.2', '::ffff:172.30.32.2'].includes(req.socket.remoteAddress || '')
    )
      return '';
    const path = req.headers['x-ingress-path'];
    return typeof path === 'string' && /^\/api\/hassio_ingress\/[a-zA-Z0-9_-]+\/?$/.test(path)
      ? path.replace(/\/$/, '')
      : '';
  }
  private async ingressAdministrator(req: IncomingMessage) {
    if (!this.ingressPath(req)) return false;
    const id = req.headers['x-remote-user-id'];
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return false;
    try {
      return await this.ingress!.isAdministrator(id);
    } catch {
      return false;
    }
  }
  private async handleSetup(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET') {
      const configured = (await this.db.select({ id: users.id }).from(users).limit(1)).length > 0;
      return send(200, {
        setupRequired: !configured && !this.ingress?.enabled,
        ingress: !!this.ingress?.enabled,
        authenticated: await this.authorize(req, res),
      });
    }
    if (req.method !== 'POST') return send(405, { error: 'Método no permitido.' });
    if (this.ingress?.enabled)
      return send(403, { error: 'Accede desde Home Assistant con una cuenta administradora.' });
    if (!this.mutationAllowed(req)) return send(403, { error: 'Origen no permitido.' });
    let input: any;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) return send(413, { error: 'Solicitud demasiado grande.' });
      }
      input = JSON.parse(body);
      if (typeof input?.username !== 'string' || typeof input?.password !== 'string')
        throw new Error();
    } catch {
      return send(400, { error: 'Introduce un usuario y una contraseña.' });
    }
    if ((await this.db.select({ id: users.id }).from(users).limit(1)).length)
      return send(409, { error: 'La configuración inicial ya se ha completado. Inicia sesión.' });
    try {
      await this.provision(input.password, false, input.username, true);
    } catch (error) {
      return send(400, {
        error: error instanceof Error ? error.message : 'No se pudo crear la cuenta.',
      });
    }
    return send(201, { created: true });
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
    if (!['request', 'reset'].includes(action)) return send(404, 'Not found');
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
    if (
      action === 'reset' &&
      (typeof input.password !== 'string' ||
        input.password.length < 12 ||
        input.password.length > 128 ||
        typeof input.code !== 'string' ||
        !/^\d{8}$/.test(input.code))
    )
      return send(400, 'Usa un código de 8 cifras y una contraseña de 12–128 caracteres.');
    let delivery: { chat: string; code: string } | undefined;
    const failure = await this.db.transaction(async (client) => {
      const [row] = await client
        .select({
          ...getTableColumns(recovery),
          current_time: sql<Date>`now()`.mapWith((value) => new Date(value)),
        })
        .from(recovery)
        .where(eq(recovery.id, 1))
        .for('update');
      const recoveryUser =
        action === 'request'
          ? typeof input.username === 'string'
            ? (
                await client
                  .select({ id: users.id })
                  .from(users)
                  .where(eq(users.username, input.username.toLowerCase()))
              )[0]?.id
            : undefined
          : row.user_id;
      const telegram = recoveryUser ? await this.recovery?.recipient() : undefined;
      const mobileConfigured =
        !telegram && recoveryUser ? await this.mobile?.configured(recoveryUser) : false;
      const recipient =
        telegram ||
        (mobileConfigured && recoveryUser ? await this.mobile!.recipient(recoveryUser) : undefined);
      if (action === 'request') {
        if (row.requested_at && row.current_time.getTime() - row.requested_at.getTime() < 60000) {
          return { status: 429, message: 'Espera un minuto antes de solicitar otro código.' };
        }
        const code = String(randomInt(10000000, 100000000));
        const active = !!recipient && !!recoveryUser;
        await client
          .update(recovery)
          .set({
            user_id: active ? recoveryUser! : null,
            requested_at: sql`now()`,
            digest: active ? this.digest(code) : null,
            recipient: active ? recipient! : null,
            expires_at: sql`now() + interval '10 minutes'`,
            attempts: 0,
          })
          .where(eq(recovery.id, 1));
        if (active) delivery = { chat: recipient!, code };
      } else {
        const digest = this.digest(input.code as string);
        const valid =
          row.user_id &&
          row.digest &&
          row.recipient === recipient &&
          row.expires_at &&
          row.expires_at > row.current_time &&
          row.attempts < 5 &&
          timingSafeEqual(Buffer.from(row.digest), Buffer.from(digest));
        await client
          .update(recovery)
          .set({ attempts: sql`least(${recovery.attempts} + 1, 5)` })
          .where(eq(recovery.id, 1));
        if (!valid) {
          return { status: 400, message: 'Código incorrecto, caducado o agotado.' };
        }
        const hash = await hashPassword(input.password as string);
        await client
          .update(accounts)
          .set({ password: hash, updatedAt: sql`now()` })
          .where(and(eq(accounts.providerId, 'credential'), eq(accounts.userId, row.user_id!)));
        await client.delete(sessions).where(eq(sessions.userId, row.user_id!));
        await client.update(recovery).set({ digest: null }).where(eq(recovery.id, 1));
      }
    });
    if (failure) return send(failure.status, failure.message);
    if (delivery) {
      try {
        if (delivery.chat.startsWith('mobile:'))
          await this.mobile!.send(delivery.chat, delivery.code);
        else await this.recovery!.send(delivery.chat, delivery.code);
      } catch {
        await this.db
          .update(recovery)
          .set({ digest: null })
          .where(and(eq(recovery.id, 1), eq(recovery.digest, this.digest(delivery.code))));
        return send(
          502,
          'No se pudo confirmar el envío. No se ha reintentado; espera un minuto antes de solicitar otro código.',
        );
      }
    }
    return send(
      200,
      action === 'request'
        ? 'Si la cuenta tiene un destino privado disponible, recibirás un código de recuperación.'
        : 'Contraseña actualizada. Inicia sesión de nuevo.',
    );
  }
  async authorize(req: IncomingMessage, res: ServerResponse) {
    if (this.ingress?.enabled) return this.ingressAdministrator(req);
    const result = await this.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    });
    const cookies = result.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    return !!result.response?.user.id;
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
