import { createServer, IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Config } from '../../domain/config.js';
import type { ConversationStore } from '../../application/ports.js';
import type { Access } from '../../application/access.js';
import type { AdminAuth } from './admin-auth.js';
import type { Admin } from './admin.js';
import type { DeploymentWebhookProxy } from './deployment-webhook.js';
import { localClock } from '../../domain/time.js';
import { rulesToken } from '../../application/rules-auth.js';

export function equalSecret(value: unknown, expected: string) {
  if (typeof value !== 'string' || !expected) return false;
  const a = Buffer.from(value),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
const chatSchema = z.object({
  session: z.string().min(1).max(128),
  text: z.string().min(1).max(150_000),
  name: z.string().max(100).default('usuario'),
});
async function body(request: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createHttpServer(
  config: Config,
  store: ConversationStore,
  icon?: Buffer,
  management?: { access: Access; admin: Admin; auth?: AdminAuth },
  deployment?: DeploymentWebhookProxy,
  rules?: { tick(): Promise<void> },
) {
  return createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    try {
      if (
        req.method === 'GET' &&
        icon &&
        ['/icon.png', '/favicon.png', '/favicon.ico'].includes(path)
      ) {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(icon);
        return;
      }
      if (req.method === 'GET' && ['/admin', '/admin/'].includes(path) && management)
        return management.admin.page(res);
      if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok' });
      if (req.method === 'POST' && path === '/v1/triggers/rules' && rules) {
        if (!equalSecret(req.headers.authorization, `Bearer ${rulesToken(config.apiKey)}`))
          return send(401, { error: 'Unauthorized' });
        void rules
          .tick()
          .catch(() => console.error(JSON.stringify({ event: 'notification_evaluation_failed' })));
        return send(202, { accepted: true });
      }
      if (path.startsWith('/api/auth/') && management?.auth) {
        await management.auth.handle(req, res);
        return;
      }
      if (req.method === 'POST' && path === '/github/deploy' && deployment) {
        const result = await deployment.forward(req);
        return send(result.status, result.body);
      }
      if (req.method === 'POST' && path === '/telegram/salem/webhook' && management) {
        const settings = (await management.access.repository.bots()).find(
          (bot) => bot.id === 'salem',
        );
        if (
          !equalSecret(
            req.headers['x-telegram-bot-api-secret-token'],
            settings?.webhookSecret || '',
          )
        )
          return send(401, { error: 'Unauthorized' });
        if (!settings?.enabled) return send(200, { ok: true });
        const update = await body(req);
        if (!Number.isSafeInteger(update.update_id)) return send(400, { error: 'Invalid update' });
        const job = await management.access.receive('salem', update, settings.token.split(':')[0]);
        return send(200, { ok: true, ...(job ? { jobId: job.id } : {}) });
      }
      if (req.method === 'POST' && path === '/telegram/webhook') {
        if (
          !equalSecret(
            req.headers['x-telegram-bot-api-secret-token'],
            config.telegram.webhookSecret,
          )
        )
          return send(401, { error: 'Unauthorized' });
        if (config.telegram.transport !== 'webhook')
          return send(503, { error: 'Webhook transport is disabled' });
        const update = await body(req),
          message = update.message;
        if (!Number.isSafeInteger(update.update_id)) return send(400, { error: 'Invalid update' });
        if (!message) return send(200, { ok: true });
        if (management) {
          const job = await management.access.receive('zero', update);
          return send(200, { ok: true, ...(job ? { jobId: job.id } : {}) });
        }
        if (!config.telegram.allowedUsers.includes(String(message.from?.id)))
          return send(403, { error: 'User not permitted' });
        if (!Number.isSafeInteger(message.chat?.id)) return send(400, { error: 'Invalid chat' });
        const job = await store.enqueue(
          'telegram:' + message.chat.id,
          { kind: 'telegram', message },
          'telegram:' + update.update_id,
        );
        return send(200, { ok: true, jobId: job.id });
      }
      if (!equalSecret(req.headers.authorization, `Bearer ${config.apiKey}`)) {
        if (
          !path.startsWith('/v1/admin/') ||
          !management?.auth ||
          !(await management.auth.authorize(req, res))
        )
          return send(401, { error: 'Tu sesión ha caducado. Inicia sesión de nuevo.' });
        if (!management.auth.mutationAllowed(req))
          return send(403, { error: 'No se pudo autorizar la solicitud desde esta página.' });
      }
      if (management && (await management.admin.handle(req, path, () => body(req), send))) return;
      if (req.method === 'POST' && path === '/v1/triggers/morning') {
        const chat = config.telegram.notificationChatId;
        if (!config.schedules.enabled || !chat)
          return send(503, { error: 'Morning notifications are disabled or have no recipient' });
        const profile = await management?.access.forSession('telegram:' + chat);
        const { day } = localClock(new Date(), profile?.timezone || config.timezone);
        const key = 'morning:' + day;
        const job = await store.enqueue('telegram:' + chat, { kind: 'morning', chatId: chat }, key);
        await store.markScheduled(key);
        return send(202, { jobId: job.id, status: job.status });
      }
      if (req.method === 'POST' && path === '/v1/chat') {
        const value = chatSchema.parse(await body(req));
        const key = req.headers['idempotency-key'];
        if (Array.isArray(key) || (typeof key === 'string' && key.length > 200))
          return send(400, { error: 'Invalid idempotency key' });
        const job = await store.enqueue(
          'api:' + value.session,
          { kind: 'chat', ...value },
          key ? `api:${value.session}:${key}` : undefined,
        );
        return send(202, { jobId: job.id, status: job.status });
      }
      if (req.method === 'GET' && path.startsWith('/v1/jobs/')) {
        const job = await store.job(path.slice('/v1/jobs/'.length));
        return job
          ? send(200, { id: job.id, status: job.status, output: job.output, error: job.error })
          : send(404, { error: 'Job not found' });
      }
      send(404, { error: 'Not found' });
    } catch (e) {
      send(400, {
        error:
          e instanceof z.ZodError
            ? 'Invalid request'
            : e instanceof SyntaxError
              ? 'Invalid JSON'
              : 'Request could not be accepted',
      });
    }
  });
}
