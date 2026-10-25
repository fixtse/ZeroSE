import { Bonjour, type ServiceConfig } from 'bonjour-service';
import { hostname } from 'node:os';

/** Only connection metadata is advertised; credentials stay in the setup flow. */
export function zeroAdvertisement(
  host: string,
  port: number,
  publicUrl?: string,
): ServiceConfig | undefined {
  let url: URL | undefined;
  if (publicUrl) {
    url = new URL(publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid Zero discovery URL');
    // Admin URLs identify the server origin, never a credential-bearing path or query.
    url = new URL(url.origin);
  } else if (!['0.0.0.0', '::'].includes(host)) {
    url = new URL(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  }
  if (url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
  if (url && Buffer.byteLength(url.origin) > 230) throw new Error('Zero discovery URL too long');
  return {
    name: `Zero (${hostname()})`,
    type: 'zero-assistant',
    protocol: 'tcp',
    port,
    txt: { version: '1', ...(url ? { url: url.origin } : {}) },
  };
}

/** Optional LAN discovery must never prevent the assistant from starting. */
export class ZeroDiscovery {
  private bonjour?: Bonjour;

  start(host: string, port: number, publicUrl?: string) {
    if (this.bonjour) return;
    const failed = () => console.error(JSON.stringify({ event: 'zero_discovery_unavailable' }));
    try {
      const advertisement = zeroAdvertisement(host, port, publicUrl);
      if (!advertisement) return;
      this.bonjour = new Bonjour(undefined, failed);
      this.bonjour.publish(advertisement).on('error', failed);
    } catch {
      failed();
      this.bonjour?.destroy();
      this.bonjour = undefined;
    }
  }

  async close() {
    const bonjour = this.bonjour;
    if (!bonjour) return;
    this.bonjour = undefined;
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        bonjour.destroy();
        resolve();
      };
      const deadline = setTimeout(finish, 1000);
      bonjour.unpublishAll(finish);
    });
  }
}
