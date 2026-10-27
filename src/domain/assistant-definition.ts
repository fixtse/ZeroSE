import type { AccessProfile, BotId } from './access.js';
export type MemoryPolicy = 'automatic' | 'explicit';
export interface AssistantDefinition {
  id: string;
  name: string;
  prompt: string;
  revision: number;
  memoryPolicy: MemoryPolicy;
  builtin: boolean;
}
export type AssistantSummary = Omit<AssistantDefinition, 'prompt'>;
/** Profiles select a saved definition; only Zero is built in. */
export function defaultAssistantId(profile?: AccessProfile, bot: BotId = 'zero') {
  return profile?.assistantId || bot;
}
