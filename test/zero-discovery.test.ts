import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zeroAdvertisement } from '../src/adapters/inbound/zero-discovery.js';

test('localhost-only servers are not advertised as reachable LAN services', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1'])
    assert.equal(zeroAdvertisement(host, 8788), undefined);
});

test('public origin supports reverse proxies without advertising paths or secrets', () => {
  const service = zeroAdvertisement('127.0.0.1', 8788, 'https://zero.example/admin?token=private');
  assert.equal(service?.type, 'zero-assistant');
  assert.equal(service?.protocol, 'tcp');
  assert.equal(service?.port, 8788);
  assert.deepEqual(service?.txt, { version: '1', url: 'https://zero.example' });
  assert.throws(() => zeroAdvertisement('0.0.0.0', 8788, 'https://user:secret@zero.example'));
  assert.throws(() => zeroAdvertisement('0.0.0.0', 8788, 'ftp://zero.example'));
});

test('wildcard listeners use the discovered address, and specific listeners retain their address', () => {
  for (const host of ['0.0.0.0', '::'])
    assert.deepEqual(zeroAdvertisement(host, 8788)?.txt, { version: '1' });
  assert.deepEqual(zeroAdvertisement('192.0.2.10', 8788)?.txt, {
    version: '1',
    url: 'http://192.0.2.10:8788',
  });
  assert.deepEqual(zeroAdvertisement('2001:db8::10', 8788)?.txt, {
    version: '1',
    url: 'http://[2001:db8::10]:8788',
  });
});
