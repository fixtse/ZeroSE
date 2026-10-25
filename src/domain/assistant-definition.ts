import type { AccessProfile, BotId } from './access.js';
export interface AssistantDefinition {
  id: string;
  name: string;
  prompt: string;
  revision: number;
  /** Preserves the imported Salem memory/response policy. */
  preset: 'standard' | 'salem';
  builtin: boolean;
}
export type AssistantSummary = Omit<AssistantDefinition, 'prompt'>;
/** Preserve the old owner/preset behavior until a profile is explicitly assigned. */
export function defaultAssistantId(profile?: AccessProfile, bot: BotId = 'zero') {
  if (profile?.assistantId) return profile.assistantId;
  const preset = profile?.promptPreset || (bot === 'salem' ? 'salem' : 'standard');
  return preset === 'salem' ? 'salem' : !profile || profile.owner ? 'zero' : 'standard';
}
