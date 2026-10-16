import type { Config } from '../domain/config.js';
import {
  membershipEvent,
  sessionAddress,
  telegramSession,
  telegramMentions,
  type AccessProfile,
  type BotId,
  type BotSettings,
} from '../domain/access.js';
import type { ConversationStore } from './ports.js';

export interface AccessRepository {
  profile(bot: BotId, chatId: string): Promise<AccessProfile | undefined>;
  profiles(
    search: string,
    offset: number,
    limit: number,
    pending?: boolean,
  ): Promise<{ items: AccessProfile[]; total: number }>;
  saveProfile(profile: AccessProfile): Promise<void>;
  discover(bot: BotId, chatId: string, label: string, kind?: 'user' | 'group'): Promise<void>;
  migrateGroup(bot: BotId, from: string, to: string): Promise<void>;
  bots(): Promise<BotSettings[]>;
  saveBot(settings: BotSettings): Promise<void>;
}

export interface WebhookStatus {
  url: string;
  pending: number;
  lastError?: string;
}
export interface WebhookControl {
  configure(settings: BotSettings): Promise<void>;
  status(settings: BotSettings): Promise<WebhookStatus>;
}

export class Access {
  constructor(
    readonly repository: AccessRepository,
    private store: ConversationStore,
    private salemUsername: () => Promise<string> = async () => '',
  ) {}
  async receive(bot: BotId, update: any, accountId?: string) {
    if (!Number.isSafeInteger(update.update_id)) throw new Error('Invalid update');
    const message = update.message;
    if (!message || !Number.isSafeInteger(message.chat?.id)) return;
    const chatId = String(message.chat.id);
    const kind =
      message.chat.type === 'private'
        ? 'user'
        : ['group', 'supergroup'].includes(message.chat.type)
          ? 'group'
          : undefined;
    if (!kind) return;
    if (kind === 'group' && (message.migrate_to_chat_id || message.migrate_from_chat_id)) {
      const from = message.migrate_from_chat_id || message.chat.id;
      const to = message.migrate_to_chat_id || message.chat.id;
      if (
        Number.isSafeInteger(from) &&
        from < 0 &&
        Number.isSafeInteger(to) &&
        to < 0 &&
        from !== to
      )
        await this.repository.migrateGroup(bot, String(from), String(to));
      return;
    }
    await this.repository.discover(
      bot,
      chatId,
      String(
        message.chat.title ||
          [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') ||
          message.chat.username ||
          chatId,
      ).slice(0, 100),
      kind,
    );
    if (!membershipEvent(message)) {
      const profile = await this.repository.profile(bot, chatId);
      if (!profile?.enabled || profile.kind !== kind) return;
      if (kind === 'user' && String(message.from?.id) !== chatId) return;
      if (bot === 'salem' && kind === 'group') {
        const mentions = telegramMentions(message);
        if (!mentions.length || !mentions.includes((await this.salemUsername()).toLowerCase()))
          return;
      }
    }
    return this.store.enqueue(
      telegramSession(bot, chatId),
      { kind: 'telegram', bot, message },
      `${bot === 'zero' ? 'telegram' : 'salem' + (accountId ? ':' + accountId : '')}:${update.update_id}`,
    );
  }
  async forSession(session: string) {
    const address = sessionAddress(session);
    return address ? this.repository.profile(address.bot, address.chatId) : undefined;
  }
}

export function scopedConfig(base: Config, profile: AccessProfile): Config {
  // Credentials are copied only for the seeded owner, never inherited by a new profile.
  const blankGoogle: Config['google'] = {
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    calendarId: 'primary',
    taskListId: '@default',
    contextDocumentId: '',
    documentFolderId: '',
    credentials: {},
  };
  const blankHA: Config['homeAssistant'] = {
    url: '',
    token: '',
    shoppingListEntity: '',
    sensorEntities: [],
    weatherEntity: '',
    locationEntity: '',
    geocodedLocationEntity: '',
  };
  const google = structuredClone(profile.google || (profile.owner ? base.google : blankGoogle));
  const memoryMode = profile.memoryMode || 'advanced';
  if (!profile.capabilities.includes('documents')) {
    google.contextDocumentId = '';
    google.documentFolderId = '';
  } else if (memoryMode === 'none') {
    google.contextDocumentId = '';
  }
  return {
    ...base,
    timezone: profile.timezone || base.timezone,
    google: profile.capabilities.some((c) => ['calendar', 'tasks', 'documents'].includes(c))
      ? google
      : blankGoogle,
    homeAssistant: profile.capabilities.includes('homeAssistant')
      ? structuredClone(profile.homeAssistant || (profile.owner ? base.homeAssistant : blankHA))
      : blankHA,
    memory: {
      ...base.memory,
      mode: memoryMode,
      geminiApiKey: memoryMode === 'advanced' ? base.memory.geminiApiKey : '',
      sharedProfile: profile.owner ? base.memory.sharedProfile : '',
    },
    telegram: {
      ...base.telegram,
      voiceReplies: base.telegram.voiceReplies && profile.voiceReplies !== false,
    },
  };
}
