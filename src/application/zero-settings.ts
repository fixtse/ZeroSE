/** Zero owns these settings. Home Assistant is an optional management client. */
export interface ZeroSettings {
  revision: number;
  prompt: string;
  homeAssistant: boolean;
  assist: boolean;
  frigate: boolean;
  services: string[];
}
export interface ZeroSettingsPort {
  read(): Promise<ZeroSettings>;
  update(value: ZeroSettings): Promise<ZeroSettings | undefined>;
}
