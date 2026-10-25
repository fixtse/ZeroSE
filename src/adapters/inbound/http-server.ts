import { createServer, IncomingMessage } from 'node:http';
import { adminAssets } from './admin-assets.js';
import type { IntegrationAccess } from '../../application/integration-access.js';
import type { SetupAdmin } from './setup-admin.js';
import type { HomeAssistantPairing } from '../../application/home-assistant-pairing.js';
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
import { voiceToken, type VoiceBridge } from '../../application/voice-bridge.js';
import { schedulerSeCallbackToken, schedulerSeEvent } from '../outbound/schedulerse.js';
import type { ZeroSettingsPort } from '../../application/zero-settings.js';
import { createHmac } from 'node:crypto';
import { weatherChangeSchema } from './weather-change-schema.js';

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
  rules?: {
    receive(event: import('../../application/notification-rules.js').RuleEvent): Promise<boolean>;
  },
  voice?: VoiceBridge,
  settings?: ZeroSettingsPort,
  integrationAccess?: IntegrationAccess,
  pairing?: HomeAssistantPairing,
  setup?: SetupAdmin,
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
      if (management && (await adminAssets(req, res))) return;
      if (
        req.method === 'GET' &&
        ['/admin/advanced', '/admin/advanced/'].includes(path) &&
        management
      )
        return management.admin.page(res);
      if (pairing && req.method === 'POST' && path === '/v1/pairing/home-assistant') {
        const input = z
          .object({
            secret: z.string().regex(/^[a-f0-9]{64}$/),
            homeAssistantUrl: z.string().url().max(2048),
            flowId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
            state: z.string().regex(/^[a-f0-9]{64}$/),
            userId: z.string().regex(/^[a-f0-9]{32}$/),
          })
          .strict()
          .parse(await body(req));
        return send(201, pairing.begin(input));
      }
      if (pairing && req.method === 'POST' && path === '/v1/pairing/home-assistant/exchange') {
        const input = z
          .object({
            id: z.uuid(),
            secret: z.string().regex(/^[a-f0-9]{64}$/),
            homeAssistantToken: z.string().min(24).max(8192),
          })
          .strict()
          .parse(await body(req));
        return send(200, await pairing.exchange(input.id, input.secret, input.homeAssistantToken));
      }
      if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok' });
      if (
        path === '/v1/integrations/home-assistant/settings' ||
        path === '/v1/integrations/home-assistant/settings/users'
      ) {
        const token = createHmac('sha256', config.apiKey)
          .update('assistant-home-assistant-settings-v1')
          .digest('hex');
        if (
          !equalSecret(req.headers.authorization, `Bearer ${token}`) &&
          !(await integrationAccess?.authorize(req.headers.authorization, 'settings'))
        )
          return send(401, { error: 'Unauthorized' });
        if (!settings) return send(503, { error: 'Settings unavailable' });
        if (path.endsWith('/users')) {
          if (req.method !== 'PUT') return send(405, { error: 'Method not allowed' });
          const value = z
            .object({
              revision: z.number().int().positive(),
              userId: z.string().regex(/^[a-f0-9]{32}$/),
              chatId: z
                .string()
                .regex(/^[1-9]\d*$/)
                .max(30)
                .nullable(),
            })
            .strict()
            .parse(await body(req));
          if (!management) return send(503, { error: 'User management unavailable' });
          if (value.chatId !== null) {
            const profile = await management.access.repository.profile('zero', value.chatId);
            if (!profile?.enabled || profile.kind !== 'user')
              return send(400, { error: 'Select an enabled private Zero user' });
          }
          const current = await settings.read();
          const bindings = { ...current.homeAssistantUsers };
          if (value.chatId === null) delete bindings[value.userId];
          else bindings[value.userId] = value.chatId;
          const updated = await settings.update({
            ...current,
            revision: value.revision,
            homeAssistantUsers: bindings,
          });
          return updated
            ? send(200, updated)
            : send(409, { error: 'Settings changed; reload before saving' });
        }
        if (req.method === 'GET') return send(200, await settings.read());
        if (req.method === 'PUT') {
          const value = z
            .object({
              revision: z.number().int().positive(),
              prompt: z.string().max(100_000),
              homeAssistant: z.boolean(),
              assist: z.boolean(),
              frigate: z.boolean(),
              services: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)).max(100),
              // Bindings are writable only through the validated /users endpoint.
              homeAssistantUsers: z.record(z.string(), z.string()).optional(),
            })
            .strict()
            .parse(await body(req));
          delete value.homeAssistantUsers;
          const updated = await settings.update(value);
          return updated
            ? send(200, updated)
            : send(409, { error: 'Settings changed; reload before saving' });
        }
        return send(405, { error: 'Method not allowed' });
      }
      if (
        path === '/v1/voice/assistants' ||
        path === '/v1/voice/turns' ||
        path.startsWith('/v1/voice/turns/')
      ) {
        if (!voice) return send(503, { error: 'Voice bridge unavailable' });
        if (
          !equalSecret(req.headers.authorization, `Bearer ${voiceToken(config.apiKey)}`) &&
          !(await integrationAccess?.authorize(req.headers.authorization, 'voice'))
        )
          return send(401, { error: 'Unauthorized' });
        if (req.method === 'GET' && path === '/v1/voice/assistants') {
          const query = new URL(req.url || '/', 'http://localhost').searchParams;
          const input = z
            .object({
              search: z.string().max(100).default(''),
              offset: z.coerce.number().int().min(0).max(1000000).default(0),
              limit: z.coerce.number().int().min(1).max(50).default(20),
            })
            .parse(Object.fromEntries(query));
          return send(200, await voice.assistants(input.search, input.offset, input.limit));
        }
        if (req.method === 'POST' && path === '/v1/voice/turns') {
          const value = z
            .object({
              request_id: z.uuid(),
              satellite_id: z.string().min(1).max(200).optional(),
              assistant_id: z.union([z.enum(['zero', 'salem', 'standard']), z.uuid()]).optional(),
              ha_user_id: z
                .string()
                .regex(/^[a-f0-9]{32}$/)
                .optional(),
              text: z.string().trim().min(1).max(16000),
            })
            .strict()
            .parse(await body(req));
          const job = await voice.submit(value);
          return job
            ? send(202, { jobId: job.id, status: job.status })
            : send(403, { error: 'Voice user or device is not enabled' });
        }
        if (req.method === 'GET' && path.startsWith('/v1/voice/turns/')) {
          const id = z.uuid().parse(path.slice('/v1/voice/turns/'.length));
          const userId = new URL(req.url || '/', 'http://localhost').searchParams.get('ha_user_id');
          const job = await voice.result(
            id,
            userId === null
              ? undefined
              : z
                  .string()
                  .regex(/^[a-f0-9]{32}$/)
                  .parse(userId),
          );
          return job
            ? send(200, { id: job.id, status: job.status, output: job.output })
            : send(404, { error: 'Voice turn not found' });
        }
        return send(404, { error: 'Not found' });
      }
      if (req.method === 'POST' && path === '/v1/triggers/schedulerse-events' && rules) {
        if (
          !equalSecret(
            req.headers.authorization,
            `Bearer ${schedulerSeCallbackToken(config.apiKey)}`,
          )
        )
          return send(401, { error: 'Unauthorized' });
        const value = z
          .object({
            event: z.literal('schedule.due'),
            event_id: z.string().min(1).max(200),
            scheduled_at: z.iso.datetime({ offset: true }),
            task: z.object({
              id: z.string().max(64),
              interval_seconds: z.number().int().min(0).max(31536000),
              context: z
                .object({
                  integration: z.literal('zero'),
                  rule_id: z.uuid(),
                  generation: z.number().int().min(0),
                })
                .strict(),
            }),
          })
          .parse(await body(req));
        const accepted = await rules.receive(schedulerSeEvent(value));
        return send(202, { accepted });
      }
      if (req.method === 'POST' && path === '/v1/triggers/rule-events' && rules) {
        if (
          !equalSecret(req.headers.authorization, `Bearer ${rulesToken(config.apiKey)}`) &&
          !(await integrationAccess?.authorize(req.headers.authorization, 'rules'))
        )
          return send(401, { error: 'Unauthorized' });
        const event = z
          .object({
            id: z.uuid(),
            generation: z.number().int().min(0),
            event_id: z.uuid(),
            fired_at: z.iso.datetime({ offset: true }),
            next_at: z.iso.datetime({ offset: true }).nullable().optional(),
            weather: weatherChangeSchema.optional(),
          })
          .strict()
          .parse(await body(req));
        const accepted = await rules.receive(event);
        return send(202, { accepted });
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
      if (setup && (await setup.handle(req, path, () => body(req), send))) return;
      if (management && (await management.admin.handle(req, path, () => body(req), send))) return;
      if (req.method === 'POST' && path === '/v1/triggers/morning') {
        const chat = config.telegram.notificationChatId;
        if (!config.schedules.enabled || !chat)
          return send(503, { error: 'Morning notifications are disabled or have no recipient' });
        const profile = await management?.access.forSession('telegram:' + chat);
        const { day } = localClock(new Date(), profile?.timezone || config.timezone);
        const key = 'wake-up:' + day;
        const job = await store.enqueue(
          'telegram:' + chat,
          { kind: 'morning', chatId: chat, wakeUp: true },
          key,
        );
        await store.markScheduled('morning:' + day);
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
