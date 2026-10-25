/** Real mDNS publication/browser check, run only in the isolated Codespace. */
import { Bonjour } from 'bonjour-service';
import assert from 'node:assert/strict';
import { ZeroDiscovery } from '../../src/adapters/inbound/zero-discovery.js';

const publisher = new ZeroDiscovery();
const browser = new Bonjour();
try {
  const found = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Zero mDNS announcement not received')), 15000);
    browser.find({ type: 'zero-assistant' }, (service) => {
      if (service.port !== 18788) return;
      try {
        assert.equal(service.txt.url, 'https://zero-discovery-test.example');
        assert.equal(service.txt.version, '1');
        assert.deepEqual(Object.keys(service.txt).sort(), ['url', 'version']);
        clearTimeout(deadline);
        resolve();
      } catch (error) {
        clearTimeout(deadline);
        reject(error);
      }
    });
  });
  publisher.start('127.0.0.1', 18788, 'https://zero-discovery-test.example');
  await found;
  console.log('Real mDNS publication and browsing passed');
} finally {
  await publisher.close();
  browser.destroy();
}
