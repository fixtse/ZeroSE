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
import type { GroupMembers } from './group-members.js';

export interface AccessRepository {
  profile(bot: BotId, chatId: string): Promise<AccessProfile | undefined>;
  profiles(
    search: string,
    offset: number,
    limit: number,
    pending?: boolean,
  ): Promise<{ items: AccessProfile[]; total: number }>;
  pairingProfiles(
    search: string,
    offset: number,
    limit: number,
  ): Promise<{
    items: { bot: string; chatId: string; label: string; kind: 'user' | 'group' }[];
    total: number;
  }>;
  saveProfile(profile: AccessProfile): Promise<void>;
  setDisabledTools?(bot: BotId, chatId: string, names: string[]): Promise<boolean>;
  removeProfile(bot: BotId, chatId: string): Promise<void>;
  discover(bot: BotId, chatId: string, label: string, kind?: 'user' | 'group'): Promise<void>;
  migrateGroup(bot: BotId, from: string, to: string): Promise<void>;
  bots(): Promise<BotSettings[]>;
  bot?(id: BotId): Promise<BotSettings | undefined>;
  saveBot(settings: BotSettings): Promise<void>;
}

export interface WebhookStatus {
  url: string;
  pending: number;
  lastError?: string;
  lastErrorAt?: number;
  reachable?: boolean;
  probeError?: string;
}
export interface WebhookControl {
  configure(settings: BotSettings): Promise<void>;
  status(settings: BotSettings): Promise<WebhookStatus>;
  remove?(settings: BotSettings): Promise<void>;
}
export interface ChatCommandsControl {
  configure(profile: AccessProfile): Promise<void>;
}

export class Access {
  constructor(
    readonly repository: AccessRepository,
    private store: ConversationStore,
    private botUsername: (bot?: BotId) => Promise<string> = async () => '',
    private groupMembers?: GroupMembers,
  ) {}
  async receive(bot: BotId, update: any, accountId?: string, legacyNamespace = false) {
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
      ) {
        await this.repository.migrateGroup(bot, String(from), String(to));
        if ((await this.repository.profile(bot, String(to)))?.kind === 'group')
          await this.groupMembers?.repository.migrate(bot, String(from), String(to));
      }
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
    if (kind === 'group') await this.groupMembers?.observe(bot, chatId, message);
    if (!membershipEvent(message)) {
      const profile = await this.repository.profile(bot, chatId);
      if (!profile?.enabled || profile.kind !== kind) return;
      if (kind === 'user' && String(message.from?.id) !== chatId) return;
      if (
        bot === 'zero' &&
        kind === 'group' &&
        profile.respondToReplies === false &&
        message.reply_to_message?.from?.is_bot === true &&
        typeof message.reply_to_message.from.username === 'string'
      ) {
        const username = (await this.botUsername(bot)).toLowerCase();
        if (
          username &&
          message.reply_to_message.from.username.toLowerCase() === username &&
          !telegramMentions(message).includes(username)
        )
          return;
      }
      if (bot !== 'zero' && kind === 'group') {
        const mentions = telegramMentions(message);
        const replySender = message.reply_to_message?.from;
        const replyUsername =
          profile.respondToReplies !== false &&
          replySender?.is_bot === true &&
          typeof replySender.username === 'string'
            ? replySender.username.toLowerCase()
            : '';
        if (!mentions.length && !replyUsername) return;
        const username = (await this.botUsername(bot)).toLowerCase();
        if (!username || (!mentions.includes(username) && replyUsername !== username)) return;
      }
    }
    return this.store.enqueue(
      telegramSession(bot, chatId),
      { kind: 'telegram', bot, message, ...(accountId ? { accountId } : {}) },
      `${bot === 'zero' ? 'telegram' + (accountId && !legacyNamespace ? ':' + accountId : '') : bot + (accountId ? ':' + accountId : '')}:${update.update_id}`,
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
    replyLanguage: profile.replyLanguage || 'es',
    media: { ...base.media, speech: profile.speech || base.media.speech },
    google: profile.capabilities.some((c) => ['calendar', 'tasks', 'documents'].includes(c))
      ? google
      : blankGoogle,
    homeAssistant: profile.capabilities.includes('homeAssistant')
      ? structuredClone(profile.homeAssistant || (profile.owner ? base.homeAssistant : blankHA))
      : {
          ...blankHA,
          taskProvider:
            profile.homeAssistant?.taskProvider ||
            (profile.owner ? base.homeAssistant.taskProvider : undefined),
          taskListEntity: profile.homeAssistant?.taskListEntity,
        },
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
