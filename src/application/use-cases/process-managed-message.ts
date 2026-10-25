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
import { salemPrompt } from '../prompts.js';
import type { AssistantDefinitions } from '../assistant-definitions.js';

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
    private telegram: (bot: BotId, session?: string) => Promise<TelegramPort>,
    private permitted: (job: Job) => Promise<boolean>,
    private ownerPrompt: string | (() => Promise<string>),
    private definitions?: Pick<AssistantDefinitions, 'resolve'>,
  ) {}
  async execute(job: Job, context: ToolContext): Promise<JobResult> {
    const address = sessionAddress(job.session);
    let identity = address?.bot === 'salem' ? 'Salem' : 'Zero';
    const telegram = await this.telegram(address?.bot || 'zero', job.session);
    if (job.payload.kind === 'telegram' && membershipEvent(job.payload.message)) {
      const input = await telegram.input(job.payload.message, job.id, context.signal);
      return { output: input.serviceReply || '', deliver: !!input.serviceReply, voice: false };
    }
    if (!(await this.permitted(job))) return { output: '', deliver: false };
    const scope = await this.scope(context);
    context.capabilities = scope.profile?.capabilities;
    context.memoryMode = scope.profile?.memoryMode || scope.config.memory.mode || 'advanced';
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
    const selected = await this.definitions?.resolve(
      scope.profile,
      address?.bot,
      job.payload.source === 'home_assistant_voice' ? job.payload.assistantId : undefined,
    );
    if (selected && selected.id !== 'standard') identity = selected.name;
    const preset =
      selected?.preset ||
      scope.profile?.promptPreset ||
      (address?.bot === 'salem' ? 'salem' : 'standard');
    const prompt = selected
      ? selected.prompt
      : preset === 'salem'
        ? salemPrompt
        : scope.profile && !scope.profile.owner
          ? ''
          : typeof this.ownerPrompt === 'string'
            ? this.ownerPrompt
            : await this.ownerPrompt();
    return new ProcessMessage(
      scope.config,
      this.store,
      this.agent,
      scope.google,
      telegram,
      prompt,
      identity,
      preset,
    ).execute(job, context);
  }
}
