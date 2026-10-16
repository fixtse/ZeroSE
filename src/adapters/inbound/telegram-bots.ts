import type { Config } from '../../domain/config.js';
import type { BotId } from '../../domain/access.js';
import type { ConversationStore } from '../../application/ports.js';
import type { Access } from '../../application/access.js';
import { Telegram } from '../outbound/telegram.js';
import { Media } from '../outbound/media.js';
import { TelegramPoller } from './telegram-poller.js';

/** Each bot owns its polling cursor and delivery credentials. Settings refresh without restarting Zero. */
export class TelegramBots {
  private zeroPoller: TelegramPoller;
  private salemPoller?: TelegramPoller;
  private salem?: Telegram;
  private token = '';
  private enabled = false;
  private timer?: NodeJS.Timeout;
  private syncing?: Promise<void>;
  constructor(
    private config: Config,
    private media: Media,
    readonly zero: Telegram,
    private store: ConversationStore,
    private access: Access,
  ) {
    this.zeroPoller = new TelegramPoller(config.telegram, zero, store, (update) =>
      access.receive('zero', update),
    );
  }
  async get(bot: BotId) {
    if (bot === 'zero') return this.zero;
    const settings = (await this.access.repository.bots()).find((b) => b.id === 'salem');
    if (!settings?.enabled || !settings.token) throw new Error('Salem is disabled');
    return new Telegram(
      { ...this.config, telegram: { ...this.config.telegram, token: settings.token } },
      this.media,
      'Salem',
    );
  }
  async isEnabled(bot: BotId) {
    if (bot === 'zero') return !!this.config.telegram.token;
    return (await this.access.repository.bots()).some(
      (b) => b.id === 'salem' && b.enabled && !!b.token,
    );
  }
  private async sync() {
    const settings = (await this.access.repository.bots()).find((b) => b.id === 'salem');
    const token = settings?.token || '';
    const enabled = !!settings?.enabled && !!token;
    if (token === this.token && enabled === this.enabled) return;
    await this.salemPoller?.close();
    this.salemPoller = undefined;
    this.token = token;
    this.enabled = enabled;
    if (!enabled) return;
    const config = {
      ...this.config,
      telegram: { ...this.config.telegram, token, transport: 'polling' as const },
    };
    this.salem = new Telegram(config, this.media, 'Salem');
    this.salemPoller = new TelegramPoller(
      config.telegram,
      this.salem,
      this.store,
      (update) => this.access.receive('salem', update, token.split(':')[0]),
      'salem:' + token.split(':')[0],
    );
    this.salemPoller.start();
  }
  start() {
    this.zeroPoller.start();
    const tick = () => {
      if (this.syncing) return;
      this.syncing = this.sync()
        .catch(() => console.error(JSON.stringify({ event: 'salem_settings_failed' })))
        .finally(() => {
          this.syncing = undefined;
        });
    };
    tick();
    this.timer = setInterval(tick, 3000);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.syncing;
    await Promise.all([this.zeroPoller.close(), this.salemPoller?.close()]);
  }
}
