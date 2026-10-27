import { createHmac } from 'node:crypto';
import type { ConversationStore } from './ports.js';
import type { Access } from './access.js';
import { homeAssistantBinding, type ZeroSettingsPort } from './zero-settings.js';
import type { BotId } from '../domain/access.js';
import type { AssistantDefinitions } from './assistant-definitions.js';

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

/** Resolve an approved private profile on its original assistant; never trust a client-supplied session. */
export async function voiceUserSession(
  userId: string,
  settings: ZeroSettingsPort,
  access: Pick<Access, 'forSession'>,
  bots: { isEnabled(bot: BotId): Promise<boolean> },
) {
  const bindings = (await settings.read()).homeAssistantUsers;
  const chatId = bindings && Object.hasOwn(bindings, userId) ? bindings[userId] : undefined;
  if (!/^[a-f0-9]{32}$/.test(userId)) return undefined;
  const binding = homeAssistantBinding(chatId);
  if (chatId && !binding) return undefined;
  const bot = binding?.bot || 'zero';
  const session = binding?.session || 'home-assistant:' + userId;
  const profile = await access.forSession(session);
  return profile?.bot === bot &&
    profile.kind === 'user' &&
    profile.enabled &&
    (await bots.isEnabled(bot))
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
    private definitions?: Pick<AssistantDefinitions, 'get' | 'list'>,
  ) {}

  private async session(userId?: string) {
    return userId === undefined ? this.ownerSession() : this.userSession?.(userId);
  }

  async submit(value: {
    request_id: string;
    satellite_id?: string;
    ha_user_id?: string;
    text: string;
    assistant_id?: string;
  }) {
    if (value.assistant_id && !(await this.definitions?.get(value.assistant_id))) return undefined;
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
        ...(value.assistant_id ? { assistantId: value.assistant_id } : {}),
        text: value.text,
        name: 'usuario',
      },
      `voice:${value.ha_user_id === undefined ? this.satellite : 'user:' + value.ha_user_id}:${value.request_id}${value.assistant_id ? ':assistant:' + value.assistant_id : ''}`,
    );
  }

  async assistants(search: string, offset: number, limit: number) {
    const page = this.definitions
      ? await this.definitions.list(search, offset, limit)
      : { items: [{ id: 'zero', name: 'Zero' }], total: 1 };
    // HA discovers names and stable identities only; never expose prompts or credentials.
    return {
      items: page.items.map((item) => ({ id: item.id, name: item.name })),
      total: page.total,
      offset,
      limit,
    };
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
