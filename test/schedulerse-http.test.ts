import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  isPrivateSchedulerAddress,
  schedulerFetch,
  schedulerHttpAddress,
} from '../src/adapters/outbound/schedulerse-http.js';

test('HTTP permits only RFC1918, loopback and IPv6 ULA, including mapped IPv4', async () => {
  for (const ip of [
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.5',
    '127.0.0.2',
    '::1',
    'fd12::1',
    'fc00::1',
    '::ffff:192.168.1.5',
  ]) {
    assert.equal(isPrivateSchedulerAddress(ip), true, ip);
  }
  for (const ip of [
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    'fe80::1',
    '::',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '::ffff:169.254.169.254',
  ]) {
    assert.equal(isPrivateSchedulerAddress(ip), false, ip);
    await assert.rejects(
      schedulerFetch(`http://${ip.includes(':') ? '[' + ip + ']' : ip}/`),
      /HTTPS/,
    );
  }
  await assert.rejects(
    schedulerHttpAddress(new URL('http://scheduler'), async () => [
      { address: '10.0.0.5', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ]),
    /HTTPS/,
  );
});

test('Docker DNS is pinned per connection, rechecked before sending credentials, and redirects never replay', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer private-test');
    assert.match(req.headers.host!, /^scheduler\.internal:/);
    if (req.url === '/redirect') {
      res.writeHead(307, { Location: 'http://8.8.8.8/' });
      res.end();
    } else res.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://scheduler.internal:${(server.address() as { port: number }).port}`;
  let dnsCalls = 0;
  const resolve = async () => {
    dnsCalls++;
    return [{ address: '127.0.0.1', family: 4 }];
  };
  const options = { method: 'POST', headers: { Authorization: 'Bearer private-test' }, body: '{}' };
  try {
    assert.deepEqual(await (await schedulerFetch(url, options, resolve)).json(), { ok: true });
    assert.equal(dnsCalls, 1);
    await assert.rejects(
      schedulerFetch(url, options, async () => [{ address: '8.8.8.8', family: 4 }]),
      /HTTPS/,
    );
    assert.equal(calls, 1);
    await assert.rejects(schedulerFetch(url + '/redirect', options, resolve), /redirecciones/);
    assert.equal(calls, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
