import type { MemoryPolicy } from './assistant-definition.js';
import type { SpeechSettings } from './speech.js';
import type { MemoryMode } from './memory.js';
import type { Config } from './config.js';

export type BotId = string;
// Existing database identities remain valid without reserving assistant names.
export const assistantIdPattern = '[a-z0-9][a-z0-9_-]{0,99}';
export const isBotId = (value: string) => new RegExp('^' + assistantIdPattern + '$').test(value);
export const capabilities = [
  'web',
  'transcription',
  'calendar',
  'tasks',
  'documents',
  'homeAssistant',
] as const;
export type Capability = (typeof capabilities)[number];
export interface AccessProfile {
  bot: BotId;
  chatId: string;
  kind: 'user' | 'group';
  label: string;
  enabled: boolean;
  capabilities: Capability[];
  owner: boolean;
  context?: string;
  contextRevision?: number;
  defaultModel?: string;
  alternateModels?: string[];
  memoryMode?: MemoryMode;
  timezone?: string;
  voiceReplies?: boolean;
  respondToReplies?: boolean;
  speech?: SpeechSettings;
  memoryPolicy?: MemoryPolicy;
  assistantId?: string;
  google?: Config['google'];
  homeAssistant?: Config['homeAssistant'];
  pairedHomeAssistant?: Config['homeAssistant'];
}
export interface BotSettings {
  id: BotId;
  token: string;
  enabled: boolean;
  webhookSecret?: string;
  webhookUrl?: string;
  transport?: 'disabled' | 'webhook' | 'polling';
  revision?: number;
}
export function telegramSession(bot: BotId, chatId: string) {
  if (bot === 'zero' && /^ha:[a-f0-9]{32}$/.test(chatId))
    return 'home-assistant:' + chatId.slice(3);
  return bot === 'zero'
    ? 'telegram:' + chatId
    : /^[a-z][a-z0-9_]{0,99}$/.test(bot)
      ? bot + ':' + chatId
      : 'telegram-assistant:' + bot + ':' + chatId;
}
export function sessionAddress(session: string): { bot: BotId; chatId: string } | undefined {
  const ha = /^home-assistant:([a-f0-9]{32})$/.exec(session);
  if (ha) return { bot: 'zero', chatId: 'ha:' + ha[1] };
  const legacy = /^([a-z][a-z0-9_-]{0,99}):(-?\d+)$/.exec(session);
  if (legacy) return { bot: legacy[1] === 'telegram' ? 'zero' : legacy[1], chatId: legacy[2] };
  const match = new RegExp('^telegram-assistant:(' + assistantIdPattern + '):(-?\\d+)$').exec(
    session,
  );
  return match ? { bot: match[1], chatId: match[2] } : undefined;
}
export const telegramWebhookPath = (id: string) => '/telegram/assistants/' + id + '/webhook';
export function membershipEvent(message: any): boolean {
  return (
    ['group', 'supergroup'].includes(message?.chat?.type) &&
    !!(
      message.group_chat_created ||
      message.supergroup_chat_created ||
      message.new_chat_members?.length
    )
  );
}
/** Only entities on the incoming message count, never quoted or replied-to text. */
export function telegramMentions(message: any): string[] {
  const mentions: string[] = [];
  for (const [text, entities] of [
    [message.text, message.entities],
    [message.caption, message.caption_entities],
  ]) {
    if (typeof text !== 'string' || !Array.isArray(entities)) continue;
    for (const entity of entities) {
      if (!Number.isInteger(entity.offset) || !Number.isInteger(entity.length)) continue;
      const value = text.slice(entity.offset, entity.offset + entity.length);
      if (entity.type === 'mention' && /^@[a-z\d_]+$/i.test(value))
        mentions.push(value.slice(1).toLowerCase());
      if (entity.type === 'bot_command' && /^\/\w+@[a-z\d_]+$/i.test(value))
        mentions.push(value.split('@')[1].toLowerCase());
    }
  }
  return mentions;
}
export function toolCapability(name: string): Capability | undefined {
  if (name.startsWith('ha_')) return 'homeAssistant';
  if (name.startsWith('calendar_')) return 'calendar';
  if (name.startsWith('task')) return 'tasks';
  if (name === 'document_create') return 'documents';
  if (['image_search', 'url_read', 'places_search', 'route_estimate'].includes(name)) return 'web';
  if (name.startsWith('alert_') || name === 'alerts_list' || name === 'weather_alert_create')
    return 'homeAssistant';
  if (
    [
      'location_get',
      'group_members_list',
      'sensors_list',
      'sensor_get',
      'sensor_history',
      'shopping_list_get',
      'shopping_list_change',
      'weather_forecast',
    ].includes(name)
  )
    return 'homeAssistant';
  return undefined;
}
