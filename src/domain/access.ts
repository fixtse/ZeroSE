import type { SpeechSettings } from './speech.js';
import type { MemoryMode } from './memory.js';
import type { Config } from './config.js';

export type BotId = 'zero' | 'salem';
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
  memoryMode?: MemoryMode;
  timezone?: string;
  voiceReplies?: boolean;
  speech?: SpeechSettings;
  promptPreset?: 'salem' | 'standard';
  assistantId?: string;
  google?: Config['google'];
  homeAssistant?: Config['homeAssistant'];
}
export interface BotSettings {
  id: BotId;
  token: string;
  enabled: boolean;
  webhookSecret?: string;
  webhookUrl?: string;
}
export function telegramSession(bot: BotId, chatId: string) {
  return `${bot === 'zero' ? 'telegram' : 'salem'}:${chatId}`;
}
export function sessionAddress(session: string): { bot: BotId; chatId: string } | undefined {
  const match = /^(telegram|salem):(-?\d+)$/.exec(session);
  return match ? { bot: match[1] === 'telegram' ? 'zero' : 'salem', chatId: match[2] } : undefined;
}
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
  if (['context_save', 'document_create'].includes(name)) return 'documents';
  if (['image_search', 'url_read', 'places_search', 'route_estimate'].includes(name)) return 'web';
  if (name.startsWith('alert_') || name === 'alerts_list' || name === 'weather_alert_create')
    return 'homeAssistant';
  if (
    [
      'location_get',
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
