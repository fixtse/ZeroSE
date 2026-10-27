import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { assistantIdPattern, type BotId } from '../../domain/access.js';
import {
  GoogleConnectionError,
  GoogleOAuthAttemptError,
  type GoogleConnection,
} from '../../application/google-connection.js';

export const googleCallbackPath = '/v1/admin/google/oauth/callback';

/** Initiation uses admin authentication/CSRF checks. Callback uses single-use state + browser cookie. */
export class GoogleOAuthAdmin {
  constructor(private connection: GoogleConnection) {}
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    const cookieName = this.connection.redirectUri.startsWith('https:')
      ? '__Host-zero-google-oauth'
      : 'zero-google-oauth';
    const browser =
      new RegExp('(?:^|;\\s*)' + cookieName + '=([A-Za-z0-9_-]{43})(?:;|$)').exec(
        req.headers.cookie || '',
      )?.[1] || '';
    if (path === googleCallbackPath && req.method === 'GET') {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        const query = new URL(req.url || '/', 'http://localhost').searchParams;
        const input = z
          .object({
            state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            code: z.string().max(4096).default(''),
            error: z.string().max(200).optional(),
          })
          .parse(Object.fromEntries(query));
        const result = await this.connection.complete(
          input.state,
          browser,
          input.code,
          !!input.error,
        );
        const target =
          '/admin/?' +
          new URLSearchParams({
            page: 'people',
            profile: result.bot + '/' + result.chatId,
            profileTab: 'google',
            googleOAuth: result.status,
          });
        res.writeHead(303, { Location: target, 'Cache-Control': 'no-store' });
        res.end();
      } catch (error) {
        send(400, {
          code: error instanceof GoogleOAuthAttemptError ? error.reason : 'invalid_callback',
          error:
            error instanceof GoogleOAuthAttemptError
              ? error.message
              : 'La respuesta de Google no es válida. Inicia una nueva autorización desde el perfil.',
        });
      }
      return true;
    }
    const match = new RegExp(
      '^/v1/admin/profiles/(' +
        assistantIdPattern +
        ')/(-?\\d{1,16}|ha:[a-f0-9]{32})/google/oauth(?:/(check))?$',
    ).exec(path);
    if (!match) return false;
    if (req.method === 'GET' && !match[3]) {
      try {
        send(200, await this.connection.details(match[1] as BotId, match[2]));
      } catch {
        send(404, { error: 'Perfil no encontrado.' });
      }
      return true;
    }
    if (req.method !== 'POST') {
      send(405, { error: 'Método no permitido.' });
      return true;
    }
    if (req.headers.origin && req.headers.origin !== new URL(this.connection.redirectUri).origin) {
      send(400, {
        code: 'origin_mismatch',
        error:
          'Abre Zero en ' +
          new URL(this.connection.redirectUri).origin +
          '/admin/ antes de conectar Google. La autorización debe empezar y terminar en la misma dirección.',
      });
      return true;
    }
    if (match[3] === 'check') {
      const input = z
        .object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
        .strict()
        .parse(await read());
      try {
        this.connection.check(input.state, browser, match[1] as BotId, match[2]);
        send(200, { ready: true });
      } catch (error) {
        send(400, {
          code: error instanceof GoogleOAuthAttemptError ? error.reason : 'invalid_attempt',
          error:
            error instanceof GoogleOAuthAttemptError
              ? error.message
              : 'No se pudo comprobar la autorización.',
        });
      }
      return true;
    }
    const input = z
      .object({
        clientId: z.string().trim().max(1000).default(''),
        clientSecret: z.string().trim().max(1000).default(''),
      })
      .strict()
      .parse(await read());
    const binding = browser || randomBytes(32).toString('base64url');
    try {
      const authorizationUrl = await this.connection.begin(
        match[1] as BotId,
        match[2],
        binding,
        input.clientId,
        input.clientSecret,
      );
      const secure = this.connection.redirectUri.startsWith('https:') ? '; Secure' : '';
      const cookies = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', [
        ...(Array.isArray(cookies) ? cookies.map(String) : cookies ? [String(cookies)] : []),
        `${cookieName}=${binding}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`,
      ]);
      send(200, { authorizationUrl });
    } catch (error) {
      send(400, {
        error:
          error instanceof GoogleConnectionError
            ? error.message
            : 'No se pudo iniciar la conexión.',
      });
    }
    return true;
  }
}
