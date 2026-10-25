import { createHmac } from 'node:crypto';
import type { ConversationStore } from './ports.js';
import type { Access } from './access.js';
import type { ZeroSettingsPort } from './zero-settings.js';
import type { BotId } from '../domain/access.js';

/** Zero is configured by the original transport, not the managed-bot table. */
export async function voiceOwnerSession(
  chat: string | undefined,
  access: Pick<Access, 'forSession'>,
  bots: { isEnabled(bot: BotId): Promise<boolean> },
) {
  if (!chat) return undefined;
  const session = 'telegram:' + chat;
  const profile = await access.forSession(session);
  return profile?.owner && profile.enabled && (await bots.isEnabled('zero')) ? session : undefined;
}

/** Resolve only private, enabled Zero profiles; never accept a client-supplied session. */
export async function voiceUserSession(
  userId: string,
  settings: ZeroSettingsPort,
  access: Pick<Access, 'forSession'>,
  bots: { isEnabled(bot: BotId): Promise<boolean> },
) {
  const bindings = (await settings.read()).homeAssistantUsers;
  const chatId = bindings && Object.hasOwn(bindings, userId) ? bindings[userId] : undefined;
  if (!chatId) return undefined;
  const session = 'telegram:' + chatId;
  const profile = await access.forSession(session);
  return profile?.bot === 'zero' &&
    profile.kind === 'user' &&
    profile.enabled &&
    (await bots.isEnabled('zero'))
    ? session
    : undefined;
}

/** HA receives a voice-only credential, never the administrator API key. */
export function voiceToken(apiKey: string) {
  return createHmac('sha256', apiKey).update('assistant-home-assistant-voice-v1').digest('hex');
}

export class VoiceBridge {
  constructor(
    private store: ConversationStore,
    private satellite: string,
    private ownerSession: () => Promise<string | undefined>,
    private userSession?: (userId: string) => Promise<string | undefined>,
  ) {}

  private async session(userId?: string) {
    return userId === undefined ? this.ownerSession() : this.userSession?.(userId);
  }

  async submit(value: {
    request_id: string;
    satellite_id?: string;
    ha_user_id?: string;
    text: string;
  }) {
    const session = await this.session(value.ha_user_id);
    if (
      !session ||
      (value.ha_user_id === undefined && (!this.satellite || value.satellite_id !== this.satellite))
    )
      return undefined;
    return this.store.enqueue(
      session,
      {
        kind: 'chat',
        source: 'home_assistant_voice',
        satellite: value.ha_user_id === undefined ? this.satellite : undefined,
        haUserId: value.ha_user_id,
        text: value.text,
        name: 'usuario',
      },
      `voice:${value.ha_user_id === undefined ? this.satellite : 'user:' + value.ha_user_id}:${value.request_id}`,
    );
  }

  async result(id: string, userId?: string) {
    const session = await this.session(userId);
    if (!session || (userId === undefined && !this.satellite)) return undefined;
    const job = await this.store.job(id);
    return job?.session === session &&
      job.payload.source === 'home_assistant_voice' &&
      job.payload.haUserId === userId &&
      (userId !== undefined || job.payload.satellite === this.satellite)
      ? job
      : undefined;
  }
}
