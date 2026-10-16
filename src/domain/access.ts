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
export function toolCapability(name: string): Capability | undefined {
  if (name.startsWith('calendar_')) return 'calendar';
  if (name.startsWith('task')) return 'tasks';
  if (['context_save', 'document_create'].includes(name)) return 'documents';
  if (['image_search', 'url_read'].includes(name)) return 'web';
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
