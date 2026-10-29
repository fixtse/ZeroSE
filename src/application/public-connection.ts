import type { ServiceSettingsPort } from './service-settings.js';

/** Explicit public server URLs predate the saved connection setting. */
export function hasPublicServerUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      !host.endsWith('.local') &&
      !/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) &&
      host !== '[::1]' &&
      host !== '[::]' &&
      !/^\[(fc|fd|fe80:)/i.test(host)
    );
  } catch {
    return false;
  }
}

/** A linked HA client may fill an empty public URL, never overwrite the user's choice. */
export class PublicConnection {
  constructor(
    private settings: ServiceSettingsPort,
    private apply: (url: string) => void,
    readonly adminUrl: string,
    private serverUrl = '',
  ) {}
  async offer(url: string) {
    const current = await this.settings.read();
    if (current.value.connectionUrl || hasPublicServerUrl(this.serverUrl))
      return { configured: false };
    const saved = await this.settings.update(current.revision, {
      ...current.value,
      connectionUrl: url,
    });
    if (saved) this.apply(url);
    return { configured: saved };
  }
}
