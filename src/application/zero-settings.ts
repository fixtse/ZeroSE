/** Zero owns these settings. Home Assistant is an optional management client. */
export interface ZeroSettings {
  revision: number;
  prompt: string;
  homeAssistant: boolean;
  assist: boolean;
  frigate: boolean;
  services: string[];
  /** Authenticated HA user ID -> enabled private Zero chat ID. */
  homeAssistantUsers?: Record<string, string>;
}
export interface ZeroSettingsPort {
  read(): Promise<ZeroSettings>;
  update(value: ZeroSettings): Promise<ZeroSettings | undefined>;
}
