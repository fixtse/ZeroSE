import { lookup } from 'node:dns/promises';
import { request } from 'node:http';
import { BlockList, isIP } from 'node:net';

const privateAddresses = new BlockList();
for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
] as const) {
  privateAddresses.addSubnet(network, prefix, 'ipv4');
  privateAddresses.addSubnet('::ffff:' + network, 96 + prefix, 'ipv6');
}
privateAddresses.addAddress('::1', 'ipv6');
privateAddresses.addSubnet('fc00::', 7, 'ipv6');
export function isPrivateSchedulerAddress(address: string) {
  const family = isIP(address);
  return family !== 0 && privateAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
type ResolveAddresses = (hostname: string) => Promise<{ address: string; family: number }[]>;
const resolveAddresses: ResolveAddresses = (hostname) => lookup(hostname, { all: true });
export async function schedulerHttpAddress(url: URL, resolve: ResolveAddresses = resolveAddresses) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolve(hostname);
  if (!addresses.length || addresses.some(({ address }) => !isPrivateSchedulerAddress(address)))
    throw new Error('SchedulerSE requiere HTTPS fuera de una red privada o loopback.');
  return addresses[0];
}

/** Pin the checked address for this connection. Never follow redirects or retry writes. */
export async function schedulerFetch(
  value: string | URL,
  options: RequestInit = {},
  resolve: ResolveAddresses = resolveAddresses,
): Promise<Response> {
  const url = new URL(value);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol))
    throw new Error('URL de SchedulerSE no válida.');
  if (url.protocol === 'https:') return fetch(url, { ...options, redirect: 'error' });
  const signal = options.signal || AbortSignal.timeout(10000);
  const address = await schedulerHttpAddress(url, resolve);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method || 'GET',
        headers: Object.fromEntries(new Headers(options.headers)),
        agent: false,
        family: address.family,
        signal,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024)
            res.destroy(new Error('Respuesta de SchedulerSE demasiado grande.'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode || 502;
          if (status >= 300 && status < 400) {
            reject(new Error('SchedulerSE no admite redirecciones. Usa la URL final.'));
            return;
          }
          resolve(new Response(status === 204 ? null : Buffer.concat(chunks), { status }));
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
