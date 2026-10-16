import type { Config } from '../../domain/config.js';
import type { BotId } from '../../domain/access.js';
import type { ConversationStore } from '../../application/ports.js';
import type { Access } from '../../application/access.js';
import { Telegram } from '../outbound/telegram.js';
import { Media } from '../outbound/media.js';
import { TelegramPoller } from './telegram-poller.js';

/** Salem receives authenticated webhooks; only Zero retains its configured legacy transport. */
export class TelegramBots {
  private zeroPoller: TelegramPoller;
  private salemIdentity?: { token: string; username: string };
  constructor(
    private config: Config,
    private media: Media,
    readonly zero: Telegram,
    store: ConversationStore,
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
  async salemUsername(): Promise<string> {
    const settings = (await this.access.repository.bots()).find((b) => b.id === 'salem');
    if (!settings?.enabled || !settings.token) return '';
    if (this.salemIdentity?.token === settings.token) return this.salemIdentity.username;
    const telegram = await this.get('salem');
    const me = await telegram.call('getMe', {}, AbortSignal.timeout(10_000));
    if (typeof me.username !== 'string' || !me.username) throw new Error('Missing Salem username');
    this.salemIdentity = { token: settings.token, username: me.username };
    return me.username;
  }
  start() {
    this.zeroPoller.start();
  }
  async close() {
    await this.zeroPoller.close();
  }
}
