import { createHmac } from 'node:crypto';
import type { ConversationStore } from './ports.js';
import type { Access } from './access.js';
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

/** HA receives a voice-only credential, never the administrator API key. */
export function voiceToken(apiKey: string) {
  return createHmac('sha256', apiKey).update('assistant-home-assistant-voice-v1').digest('hex');
}

export class VoiceBridge {
  constructor(
    private store: ConversationStore,
    private satellite: string,
    private ownerSession: () => Promise<string | undefined>,
  ) {}

  async submit(value: { request_id: string; satellite_id: string; text: string }) {
    const session = await this.ownerSession();
    if (!session || !this.satellite || value.satellite_id !== this.satellite) return undefined;
    return this.store.enqueue(
      session,
      {
        kind: 'chat',
        source: 'home_assistant_voice',
        satellite: this.satellite,
        text: value.text,
        name: 'usuario',
      },
      `voice:${this.satellite}:${value.request_id}`,
    );
  }

  async result(id: string) {
    const session = await this.ownerSession();
    if (!session || !this.satellite) return undefined;
    const job = await this.store.job(id);
    return job?.session === session &&
      job.payload.source === 'home_assistant_voice' &&
      job.payload.satellite === this.satellite
      ? job
      : undefined;
  }
}
