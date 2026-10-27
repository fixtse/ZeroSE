import { sessionAddress, telegramSession } from '../domain/access.js';
/** Zero owns these settings. Home Assistant is an optional management client. */
export interface ZeroSettings {
  revision: number;
  prompt: string;
  homeAssistant: boolean;
  assist: boolean;
  frigate: boolean;
  services: string[];
  /** HA user ID -> legacy Zero chat ID or canonical private assistant session. */
  homeAssistantUsers?: Record<string, string>;
}
export interface ZeroSettingsPort {
  read(): Promise<ZeroSettings>;
  update(value: ZeroSettings): Promise<ZeroSettings | undefined>;
}

/** Only server-approved private Telegram profiles can become HA voice bindings. */
export function homeAssistantBinding(value: string | undefined) {
  if (!value) return undefined;
  const address = /^[1-9]\d{0,15}$/.test(value)
    ? { bot: 'zero', chatId: value }
    : sessionAddress(value);
  if (!address || !/^[1-9]\d{0,15}$/.test(address.chatId)) return undefined;
  return { ...address, session: telegramSession(address.bot, address.chatId) };
}
