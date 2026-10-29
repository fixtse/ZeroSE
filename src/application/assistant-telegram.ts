import { secretHint } from './secret-hint.js';
import type { BotSettings } from '../domain/access.js';
import { telegramWebhookPath } from '../domain/access.js';
import type { Config } from '../domain/config.js';
import type { WebhookControl } from './access.js';
import type { AssistantDefinitions } from './assistant-definitions.js';

export interface AssistantTelegramRepository {
  bot(id: string): Promise<BotSettings | undefined>;
  bots(): Promise<BotSettings[]>;
  saveConnection(value: BotSettings, revision: number): Promise<boolean>;
}
export class TelegramConnectionConflict extends Error {}
export class AssistantTelegram {
  constructor(
    private repository: AssistantTelegramRepository,
    private legacy: Config['telegram'],
    private publicUrl: string | (() => string),
    private definitions: Pick<AssistantDefinitions, 'get'>,
    private validate: (token: string) => Promise<void>,
    private secret: () => string,
    private webhooks: WebhookControl,
    private changed: (id: string) => Promise<void>,
  ) {}
  private connectionUrl() {
    return typeof this.publicUrl === 'function' ? this.publicUrl() : this.publicUrl;
  }
  async effective(id: string): Promise<BotSettings> {
    const saved = await this.repository.bot(id);
    return saved
      ? {
          ...saved,
          transport: saved.transport || 'webhook',
          webhookUrl: saved.webhookUrl || this.connectionUrl() + telegramWebhookPath(id),
        }
      : id === 'zero'
        ? {
            id,
            token: this.legacy.token,
            enabled: !!this.legacy.token && this.legacy.transport !== 'disabled',
            transport: this.legacy.transport,
            webhookSecret: this.legacy.webhookSecret,
            webhookUrl: this.connectionUrl() + telegramWebhookPath(id),
            revision: 0,
          }
        : {
            id,
            token: '',
            enabled: false,
            transport: 'webhook',
            webhookUrl: this.connectionUrl() + telegramWebhookPath(id),
            revision: 0,
          };
  }
  async read(id: string) {
    const value = await this.effective(id);
    return {
      id,
      enabled: value.enabled,
      configured: !!value.token,
      tokenHint: secretHint(value.token),
      transport: value.transport,
      webhookUrl: value.webhookUrl,
      revision: value.revision || 0,
      accountId: value.token.split(':')[0] || '',
      source: (await this.repository.bot(id)) ? 'saved' : id === 'zero' ? 'server' : 'none',
    };
  }
  async save(
    id: string,
    input: {
      token: string;
      enabled: boolean;
      transport: 'disabled' | 'webhook' | 'polling';
      webhookUrl: string;
      revision: number;
      clearToken: boolean;
    },
  ) {
    if (!(await this.definitions.get(id))) throw new Error('Asistente no encontrado.');
    const previous = await this.effective(id);
    const token = input.clearToken ? '' : input.token.trim() || previous.token;
    if (input.enabled && (!token || input.transport === 'disabled'))
      throw new Error('Introduce un token y selecciona un transporte antes de activar Telegram.');
    if (token && !/^\d+:[\w-]+$/.test(token)) throw new Error('El token de Telegram no es válido.');
    const account = token.split(':')[0];
    const connections = await this.repository.bots();
    if (!connections.some((value) => value.id === 'zero'))
      connections.push(await this.effective('zero'));
    if (
      token &&
      connections.some((value) => value.id !== id && value.token.split(':')[0] === account)
    )
      throw new TelegramConnectionConflict(
        'Este bot de Telegram ya está conectado a otro asistente.',
      );
    if (input.token.trim() && !input.clearToken) await this.validate(token);
    const webhookUrl = input.webhookUrl.trim();
    if (input.transport === 'webhook' && input.enabled) {
      let url: URL;
      try {
        url = new URL(webhookUrl);
      } catch {
        throw new Error('Introduce la URL HTTPS pública del webhook.');
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        ![
          telegramWebhookPath(id),
          new URL(this.connectionUrl()).pathname.replace(/\/+$/, '') + telegramWebhookPath(id),
        ].includes(url.pathname)
      )
        throw new Error(
          'Usa una URL HTTPS pública que termine en ' +
            telegramWebhookPath(id) +
            ', sin credenciales ni parámetros.',
        );
    }
    const value: BotSettings = {
      id,
      token,
      enabled: input.enabled,
      transport: input.transport,
      webhookUrl,
      webhookSecret:
        token && previous.token.split(':')[0] === account && previous.webhookSecret
          ? previous.webhookSecret
          : this.secret(),
    };
    if (!(await this.repository.saveConnection(value, input.revision)))
      throw new TelegramConnectionConflict(
        'La conexión ha cambiado o el bot ya está en uso. Recarga antes de guardar.',
      );
    try {
      await this.changed(id);
    } catch {
      throw new Error(
        'La conexión se guardó, pero no se pudo confirmar su activación. Consulta el estado antes de repetir.',
      );
    }
    return this.read(id);
  }
  async register(id: string, revision: number) {
    const value = await this.effective(id);
    if ((value.revision || 0) !== revision)
      throw new TelegramConnectionConflict(
        'La conexión ha cambiado. Recarga antes de registrar el webhook.',
      );
    if (!value.enabled || !value.token || value.transport !== 'webhook')
      throw new Error('Activa y guarda una conexión webhook antes de registrarla.');
    await this.webhooks.configure(value);
  }
  async remove(id: string, revision: number) {
    const value = await this.effective(id);
    if ((value.revision || 0) !== revision)
      throw new TelegramConnectionConflict(
        'La conexión ha cambiado. Recarga antes de eliminar el webhook.',
      );
    if (!value.token || !this.webhooks.remove)
      throw new Error('No se puede eliminar este webhook.');
    await this.webhooks.remove(value);
    // Clear credentials only after Telegram confirms removal. Preserve concurrent edits.
    if (
      !(await this.repository.saveConnection(
        {
          ...value,
          token: '',
          webhookSecret: '',
          enabled: false,
          transport: 'disabled',
        },
        revision,
      ))
    )
      throw new TelegramConnectionConflict(
        'El webhook se eliminó, pero la conexión cambió. Recarga antes de hacer otro cambio.',
      );
    await this.changed(id);
  }
  async status(id: string) {
    const value = await this.effective(id);
    if (!value.token) throw new Error('Configura primero el token del asistente.');
    return { ...(await this.webhooks.status(value)), expectedUrl: value.webhookUrl };
  }
}
