import type { ServiceSettingsPort } from './service-settings.js';

/** A linked HA client may fill an empty public URL, never overwrite the user's choice. */
export class PublicConnection {
  constructor(
    private settings: ServiceSettingsPort,
    private apply: (url: string) => void,
    readonly adminUrl: string,
  ) {}
  async offer(url: string) {
    const current = await this.settings.read();
    if (current.value.connectionUrl) return { configured: false };
    const saved = await this.settings.update(current.revision, {
      ...current.value,
      connectionUrl: url,
    });
    if (saved) this.apply(url);
    return { configured: saved };
  }
}
