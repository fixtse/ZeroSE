import type { Config } from '../../domain/config.js';
import {
  membershipEvent,
  sessionAddress,
  type AccessProfile,
  type BotId,
} from '../../domain/access.js';
import type { Job, ToolContext } from '../../domain/models.js';
import type { AgentPort, ConversationStore, GooglePort, TelegramPort } from '../ports.js';
import { ProcessMessage } from './process-message.js';
import type { JobResult } from './contracts.js';

export interface ProfileScope {
  config: Config;
  google: GooglePort;
  profile?: AccessProfile;
}

/** Apply chat access before loading media, account context or invoking an agent. */
export class ProcessManagedMessage {
  constructor(
    private store: ConversationStore,
    private agent: AgentPort,
    private scope: (context: ToolContext) => Promise<ProfileScope>,
    private telegram: (bot: BotId) => Promise<TelegramPort>,
    private permitted: (job: Job) => Promise<boolean>,
    private ownerPrompt: string,
  ) {}
  async execute(job: Job, context: ToolContext): Promise<JobResult> {
    const address = sessionAddress(job.session);
    const identity = address?.bot === 'salem' ? 'Salem' : 'Zero';
    const telegram = await this.telegram(address?.bot || 'zero');
    if (job.payload.kind === 'telegram' && membershipEvent(job.payload.message)) {
      const input = await telegram.input(job.payload.message, job.id, context.signal);
      return { output: input.serviceReply || '', deliver: !!input.serviceReply, voice: false };
    }
    if (!(await this.permitted(job))) return { output: '', deliver: false };
    const scope = await this.scope(context);
    context.capabilities = scope.profile?.capabilities;
    if (job.payload.kind === 'telegram' && !context.capabilities?.includes('transcription')) {
      const message = job.payload.message;
      if (!message.text && !message.caption)
        return {
          output: 'Los archivos multimedia no están habilitados para este chat.',
          voice: false,
        };
      job = {
        ...job,
        payload: { ...job.payload, message: { text: message.text || message.caption } },
      };
    }
    const prompt = scope.profile && !scope.profile.owner ? '' : this.ownerPrompt;
    return new ProcessMessage(
      scope.config,
      this.store,
      this.agent,
      scope.google,
      telegram,
      prompt,
      identity,
    ).execute(job, context);
  }
}
