import type { Config } from '../../domain/config.js';
import type { BotId, BotSettings } from '../../domain/access.js';
import type { ConversationStore } from '../../application/ports.js';
import { scopedConfig, type Access } from '../../application/access.js';
import { Telegram } from '../outbound/telegram.js';
import { Media } from '../outbound/media.js';
import { TelegramPoller } from './telegram-poller.js';

/** Optional assistant connections; legacy sessions and Zero's original cursor remain intact. */
export class TelegramBots {
  private pollers = new Map<string, TelegramPoller>();
  private identities = new Map<string, { token: string; username: string }>();
  constructor(
    private config: Config,
    private media: Media,
    readonly zero: Telegram,
    private store: ConversationStore,
    private access: Access,
    private name: (id: string) => Promise<string> = async () => 'Assistant',
  ) {}
  async settings(id: BotId): Promise<BotSettings> {
    const saved = this.access.repository.bot
      ? await this.access.repository.bot(id)
      : (await this.access.repository.bots()).find((bot) => bot.id === id);
    return saved
      ? { ...saved, transport: saved.transport || 'webhook' }
      : id === 'zero'
        ? {
            id,
            enabled: !!this.config.telegram.token && this.config.telegram.transport !== 'disabled',
            token: this.config.telegram.token,
            transport: this.config.telegram.transport,
            webhookSecret: this.config.telegram.webhookSecret,
          }
        : { id, enabled: false, token: '', transport: 'disabled' };
  }
  async get(bot: BotId, session?: string) {
    const profile = session ? await this.access.forSession(session) : undefined;
    const config = profile ? scopedConfig(this.config, profile) : this.config;
    const settings = await this.settings(bot);
    if (bot !== 'zero' && (!settings.enabled || !settings.token))
      throw new Error('Assistant Telegram connection is disabled');
    return new Telegram(
      { ...config, telegram: { ...config.telegram, token: settings.token } },
      session ? new Media(config) : this.media,
      bot === 'zero' ? 'Zero' : await this.name(bot),
    );
  }
  async isEnabled(bot: BotId) {
    const value = await this.settings(bot);
    return !!value.enabled && !!value.token;
  }
  async matchesAccount(bot: BotId, accountId?: string) {
    const value = await this.settings(bot);
    if (accountId) return value.token.split(':')[0] === accountId;
    return bot !== 'zero' || value.token.split(':')[0] === this.config.telegram.token.split(':')[0];
  }
  async username(bot: BotId = 'salem') {
    const settings = await this.settings(bot);
    if (!settings.enabled || !settings.token) return '';
    const cached = this.identities.get(bot);
    if (cached?.token === settings.token) return cached.username;
    const me = await (await this.get(bot)).call('getMe', {}, AbortSignal.timeout(10000));
    if (typeof me.username !== 'string' || !me.username)
      throw new Error('Missing Telegram username');
    this.identities.set(bot, { token: settings.token, username: me.username });
    return me.username as string;
  }
  salemUsername() {
    return this.username('salem');
  }
  async reconfigure(id: BotId) {
    await this.pollers.get(id)?.close();
    this.pollers.delete(id);
    this.identities.delete(id);
    const settings = await this.settings(id);
    if (!settings.enabled || !settings.token || settings.transport !== 'polling') return;
    const account = settings.token.split(':')[0];
    const legacy = id === 'zero' && account === this.config.telegram.token.split(':')[0];
    const poller = new TelegramPoller(
      { ...this.config.telegram, transport: 'polling', token: settings.token },
      await this.get(id),
      this.store,
      (update) => this.access.receive(id, update, account, legacy),
      legacy ? 'telegram' : 'telegram-bot:' + id + ':' + account,
    );
    this.pollers.set(id, poller);
    poller.start();
  }
  async start() {
    for (const id of new Set([
      'zero',
      ...(await this.access.repository.bots()).map((bot) => bot.id),
    ]))
      await this.reconfigure(id);
  }
  async close() {
    await Promise.all([...this.pollers.values()].map((poller) => poller.close()));
  }
}
