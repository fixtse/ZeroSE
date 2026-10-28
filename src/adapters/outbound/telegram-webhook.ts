import type { BotSettings } from '../../domain/access.js';
import { telegramWebhookPath } from '../../domain/access.js';
import { randomUUID } from 'node:crypto';

import type { WebhookControl, WebhookStatus } from '../../application/access.js';

interface TelegramApi {
  call(method: string, body: unknown, signal?: AbortSignal): Promise<any>;
}
/** Registrations happen only for an explicit administrator request, never on a timer or startup. */
export class TelegramWebhook implements WebhookControl {
  constructor(
    private telegram: (settings: BotSettings) => TelegramApi,
    private request: typeof fetch = fetch,
  ) {}
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
  async remove(settings: BotSettings) {
    const result = await this.telegram(settings).call(
      'deleteWebhook',
      { drop_pending_updates: false },
      AbortSignal.timeout(15000),
    );
    if (result !== true) throw new Error('Telegram did not confirm webhook removal');
  }
  async status(settings: BotSettings): Promise<WebhookStatus> {
    const info = await this.telegram(settings).call(
      'getWebhookInfo',
      {},
      AbortSignal.timeout(10000),
    );
    const status: WebhookStatus = {
      url: info.url || '',
      pending: info.pending_update_count || 0,
      lastError: info.last_error_message,
      lastErrorAt: info.last_error_date,
    };
    if (
      settings.enabled &&
      settings.transport === 'webhook' &&
      status.url === settings.webhookUrl
    ) {
      status.reachable = false;
      try {
        const url = new URL(settings.webhookUrl!);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== telegramWebhookPath(settings.id) ||
          !settings.webhookSecret
        )
          throw new Error('Invalid webhook configuration');
        const challenge = randomUUID();
        const response = await this.request(url, {
          method: 'POST',
          headers: {
            'X-Telegram-Bot-Api-Secret-Token': settings.webhookSecret,
            'X-Zero-Webhook-Probe': challenge,
          },
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          status.probeError = 'La URL pública del webhook respondió HTTP ' + response.status + '.';
        } else {
          const result = (await response.json()) as Record<string, unknown>;
          status.reachable =
            result.webhookProbe === challenge &&
            result.assistantId === settings.id &&
            result.enabled === true;
          if (!status.reachable)
            status.probeError = 'La URL pública no confirmó el webhook de este asistente.';
        }
      } catch {
        status.probeError =
          'No se pudo verificar la URL pública del webhook. Comprueba la conexión y vuelve a consultar.';
      }
    }
    return status;
  }
}
