import { createHmac } from 'node:crypto';
import type { ConversationStore } from './ports.js';

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
