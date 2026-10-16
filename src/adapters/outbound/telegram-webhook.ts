import type { BotSettings } from '../../domain/access.js';

import type { WebhookControl, WebhookStatus } from '../../application/access.js';

interface TelegramApi {
  call(method: string, body: unknown, signal?: AbortSignal): Promise<any>;
}
/** Registrations happen only for an explicit administrator request, never on a timer or startup. */
export class TelegramWebhook implements WebhookControl {
  constructor(private telegram: (settings: BotSettings) => TelegramApi) {}
  async configure(settings: BotSettings) {
    if (!settings.webhookUrl || !settings.webhookSecret)
      throw new Error('Webhook is not configured');
    const result = await this.telegram(settings).call(
      'setWebhook',
      {
        url: settings.webhookUrl,
        secret_token: settings.webhookSecret,
        allowed_updates: ['message'],
        drop_pending_updates: false,
      },
      AbortSignal.timeout(15000),
    );
    if (result !== true) throw new Error('Telegram did not confirm webhook registration');
  }
  async status(settings: BotSettings): Promise<WebhookStatus> {
    const info = await this.telegram(settings).call(
      'getWebhookInfo',
      {},
      AbortSignal.timeout(10000),
    );
    return {
      url: info.url || '',
      pending: info.pending_update_count || 0,
      lastError: info.last_error_message,
    };
  }
}
