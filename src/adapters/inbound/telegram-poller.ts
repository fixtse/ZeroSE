import type { Config } from '../../domain/config.js';
import type { ConversationStore } from '../../application/ports.js';

interface TelegramApi {
  call(method: string, body: unknown, signal?: AbortSignal): Promise<any>;
}
/** Outbound long polling supplies inbound messages without a public ingress URL. */
export class TelegramPoller {
  private controller = new AbortController();
  private running?: Promise<void>;
  constructor(
    private config: Config['telegram'],
    private telegram: TelegramApi,
    private store: ConversationStore,
    private receive?: (update: any) => Promise<unknown>,
    private cursorName = 'telegram',
  ) {}
  start() {
    if (this.config.transport !== 'polling') return;
    this.running = this.run().catch(() => {
      console.error(
        JSON.stringify({
          event: 'telegram_polling_stopped',
          reason: 'Check Telegram connectivity or existing webhook',
        }),
      );
    });
  }
  private async run() {
    const info = await this.telegram.call('getWebhookInfo', {}, this.controller.signal);
    if (info.url) throw new Error('Existing Telegram webhook must be removed before polling');
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try {
        const updates = await this.telegram.call(
          'getUpdates',
          {
            offset: await this.store.cursor(this.cursorName),
            timeout: 25,
            allowed_updates: ['message'],
          },
          AbortSignal.any([this.controller.signal, AbortSignal.timeout(35_000)]),
        );
        for (const update of updates) {
          if (!Number.isSafeInteger(update.update_id)) throw new Error('Invalid Telegram update');
          const message = update.message;
          if (this.receive) {
            await this.receive(update);
          } else if (
            message &&
            this.config.allowedUsers.includes(String(message.from?.id)) &&
            Number.isSafeInteger(message.chat?.id)
          ) {
            await this.store.enqueue(
              'telegram:' + message.chat.id,
              { kind: 'telegram', message },
              'telegram:' + update.update_id,
            );
          }
          await this.store.setCursor(this.cursorName, update.update_id + 1);
        }
        failures = 0;
      } catch (error) {
        if (this.controller.signal.aborted) return;
        if (++failures >= 3) throw error;
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            this.controller.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, 1000 * failures);
          this.controller.signal.addEventListener('abort', finish, { once: true });
        });
      }
    }
  }
  async close() {
    this.controller.abort();
    await this.running;
  }
}
