import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { adminAssets } from '../src/adapters/inbound/admin-assets.js';

test('static admin serves the exported UI and assets with security headers and contains paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zero-assets-'));
  const root = join(directory, 'out');
  await mkdir(join(root, '_next/static'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<html>Zero UI</html>');
  await writeFile(join(root, '_next/static/app.js'), 'console.log("Zero")');
  await writeFile(join(directory, 'private.json'), 'never public');
  const server = createServer(async (req, res) => {
    if (!(await adminAssets(req, res, root))) {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of ['/admin', '/admin/']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '<html>Zero UI</html>');
      assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
      assert.match(response.headers.get('content-security-policy')!, /media-src blob:/);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    }
    const asset = await fetch(base + '/admin/_next/static/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type')!, /javascript/);
    for (const path of ['/admin/advanced', '/admin/%2e%2e%2fprivate.json', '/admin/missing.js'])
      assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(base + '/admin/', { method: 'POST' })).status, 404);
    assert.equal(await (await fetch(base + '/admin/', { method: 'HEAD' })).text(), '');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
