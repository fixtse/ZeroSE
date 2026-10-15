import { createServer, IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Config } from '../../domain/config.js';
import type { ConversationStore } from '../../application/ports.js';

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
export function createHttpServer(config: Config, store: ConversationStore) {
  return createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok' });
      if (req.method === 'POST' && path === '/telegram/webhook') {
        if (
          !equalSecret(
            req.headers['x-telegram-bot-api-secret-token'],
            config.telegram.webhookSecret,
          )
        )
          return send(401, { error: 'Unauthorized' });
        const update = await body(req),
          message = update.message;
        if (!Number.isSafeInteger(update.update_id)) return send(400, { error: 'Invalid update' });
        if (!message) return send(200, { ok: true });
        if (!config.telegram.allowedUsers.includes(String(message.from?.id)))
          return send(403, { error: 'User not permitted' });
        if (!Number.isSafeInteger(message.chat?.id)) return send(400, { error: 'Invalid chat' });
        const job = store.enqueue(
          'telegram:' + message.chat.id,
          { kind: 'telegram', message },
          'telegram:' + update.update_id,
        );
        return send(200, { ok: true, jobId: job.id });
      }
      if (!equalSecret(req.headers.authorization, `Bearer ${config.apiKey}`))
        return send(401, { error: 'Unauthorized' });
      if (req.method === 'POST' && path === '/v1/chat') {
        const value = chatSchema.parse(await body(req));
        const key = req.headers['idempotency-key'];
        if (Array.isArray(key) || (typeof key === 'string' && key.length > 200))
          return send(400, { error: 'Invalid idempotency key' });
        const job = store.enqueue(
          'api:' + value.session,
          { kind: 'chat', ...value },
          key ? `api:${value.session}:${key}` : undefined,
        );
        return send(202, { jobId: job.id, status: job.status });
      }
      if (req.method === 'GET' && path.startsWith('/v1/jobs/')) {
        const job = store.job(path.slice('/v1/jobs/'.length));
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
