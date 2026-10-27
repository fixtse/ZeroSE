import { isBotId } from '../../domain/access.js';
import type { ServiceSettingsAdmin } from './service-settings-admin.js';
import type { AssistantAdmin } from './assistant-admin.js';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { IntegrationAccess } from '../../application/integration-access.js';
import type { HomeAssistantPairing } from '../../application/home-assistant-pairing.js';
import type { ZeroSettingsPort } from '../../application/zero-settings.js';
import type { AccessRepository } from '../../application/access.js';
export class SetupAdmin {
  constructor(
    private tokens: IntegrationAccess,
    private pairing: HomeAssistantPairing,
    private settings: ZeroSettingsPort,
    private profiles: AccessRepository,
    private publicUrl: string,
    private assistants?: AssistantAdmin,
    private homeAssistantConnected: () => Promise<boolean> = async () => false,
    private services?: ServiceSettingsAdmin,
  ) {}
  async handle(
    req: IncomingMessage,
    path: string,
    read: () => Promise<unknown>,
    send: (status: number, value: unknown) => void,
  ) {
    if (!path.startsWith('/v1/admin/setup/')) return false;
    if (await this.services?.handle(req, path, read, send)) return true;
    if (await this.assistants?.handle(req, path, read, send)) return true;
    if (path === '/v1/admin/setup/connection' && req.method === 'GET') {
      send(200, {
        homeAssistantConnected: await this.homeAssistantConnected(),
        url: this.publicUrl,
        callbackUrl: this.publicUrl + '/v1/triggers/rule-events',
        discovery: '_zero-assistant._tcp',
        fields: ['url', 'token', 'callback_url', 'callback_token', 'settings_token'],
      });
    } else if (path === '/v1/admin/setup/tokens' && req.method === 'GET') {
      const query = new URL(req.url || '/', 'http://localhost').searchParams;
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(1000000)
        .parse(query.get('offset') || 0);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .parse(query.get('limit') || 20);
      send(200, { ...(await this.tokens.list(offset, limit)), offset, limit });
    } else if (path === '/v1/admin/setup/tokens' && req.method === 'POST') {
      const input = z
        .object({
          name: z.string().trim().min(1).max(100),
          days: z.number().int().min(1).max(3650),
        })
        .strict()
        .parse(await read());
      send(201, await this.tokens.issue(input.name, input.days));
    } else if (/^\/v1\/admin\/setup\/tokens\/[a-f0-9-]+$/.test(path) && req.method === 'DELETE') {
      await this.tokens.revoke(z.uuid().parse(path.split('/').pop()));
      send(200, { revoked: true });
    } else if (
      /^\/v1\/admin\/setup\/pairings\/[a-f0-9-]+\/profiles$/.test(path) &&
      req.method === 'GET'
    ) {
      this.pairing.details(z.uuid().parse(path.split('/').at(-2)));
      const query = new URL(req.url || '/', 'http://localhost').searchParams;
      const search = z
        .string()
        .max(200)
        .parse(query.get('search') || '');
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(1000000)
        .parse(query.get('offset') || 0);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .parse(query.get('limit') || 20);
      const page = await this.profiles.pairingProfiles(search, offset, limit);
      send(200, {
        ...page,
        offset,
        limit,
        next_offset: offset + limit < page.total ? offset + limit : null,
      });
    } else if (/^\/v1\/admin\/setup\/pairings\/[a-f0-9-]+$/.test(path) && req.method === 'GET') {
      send(200, this.pairing.details(z.uuid().parse(path.split('/').pop())));
    } else if (
      /^\/v1\/admin\/setup\/pairings\/[a-f0-9-]+\/approve$/.test(path) &&
      req.method === 'POST'
    ) {
      const input = z
        .object({
          chatId: z.string().regex(/^-?[1-9]\d{0,15}$/),
          bot: z.string().refine(isBotId).default('zero'),
        })
        .strict()
        .parse(await read());
      send(
        200,
        await this.pairing.approve(z.uuid().parse(path.split('/').at(-2)), input.chatId, input.bot),
      );
    } else if (path === '/v1/admin/setup/settings' && req.method === 'GET') {
      send(200, await this.settings.read());
    } else if (path === '/v1/admin/setup/users' && req.method === 'PUT') {
      const input = z
        .object({
          revision: z.number().int().positive(),
          userId: z.string().regex(/^[a-f0-9]{32}$/),
          chatId: z
            .string()
            .regex(/^[1-9]\d{0,15}$/)
            .nullable(),
        })
        .strict()
        .parse(await read());
      if (input.chatId) {
        const profile = await this.profiles.profile('zero', input.chatId);
        if (!profile?.enabled || profile.kind !== 'user') {
          send(400, { error: 'Selecciona un usuario privado de Zero activo.' });
          return true;
        }
      }
      const current = await this.settings.read();
      const bindings = { ...current.homeAssistantUsers };
      if (input.chatId) bindings[input.userId] = input.chatId;
      else delete bindings[input.userId];
      const updated = await this.settings.update({
        ...current,
        revision: input.revision,
        homeAssistantUsers: bindings,
      });
      send(
        updated ? 200 : 409,
        updated || { error: 'La configuración ha cambiado. Recarga antes de guardar.' },
      );
    } else send(404, { error: 'Not found' });
    return true;
  }
}
