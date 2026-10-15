import { z } from 'zod';
import { Tools, text } from '../../application/tool-registry.js';
import { jsonRequest, boundedBody } from './http.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// URL reads must never give model-supplied URLs access to private integration endpoints.
function publicAddress(address: string) {
  if (isIP(address) === 6)
    return !/^(::|fc|fd|fe[89ab]|ff)/i.test(address) && !address.toLowerCase().includes('ffff:');
  const [a, b] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
export function registerSearch(tools: Tools, key: string) {
  if (key)
    tools.add(
      'image_search',
      'Find image URLs using Brave Image Search.',
      z.object({ query: text }),
      async (a, c) => {
        const result = await jsonRequest(
          'https://api.search.brave.com/res/v1/images/search?' +
            new URLSearchParams({ q: a.query, count: '5' }),
          {
            headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
            signal: c.signal,
          },
          'Brave Search',
        );
        return result.results?.map((r: any) => ({
          title: r.title,
          url: r.properties?.url,
          source: r.url,
        }));
      },
    );
  tools.add(
    'url_read',
    'Read text from a public HTTPS web page. Cannot access private network services.',
    z.object({ url: z.url() }),
    async (a, c) => {
      const url = new URL(a.url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (url.port && url.port !== '443')
      )
        throw new Error('Only public HTTPS pages are supported');
      const addresses = await lookup(url.hostname, { all: true });
      if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
        throw new Error('Private network URLs are not permitted');
      // Jina fetches the public page remotely, so DNS rebinding cannot reach this host's LAN.
      const response = await fetch('https://r.jina.ai/' + url.href, {
        redirect: 'error',
        signal: c.signal,
      });
      return {
        url: url.href,
        text: (await boundedBody(response, 500_000)).toString('utf8').slice(0, 100_000),
      };
    },
  );
}
