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
  await writeFile(join(root, 'zero-logo.webp'), Buffer.from('RIFFwebp'));
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
      assert.match(response.headers.get('content-security-policy')!, /img-src 'self' data: blob:/);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    }
    const asset = await fetch(base + '/admin/_next/static/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type')!, /javascript/);
    const logo = await fetch(base + '/admin/zero-logo.webp');
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/webp');
    assert.equal(await logo.text(), 'RIFFwebp');
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

test('Ingress assets retain their prefix and allow only same-origin framing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zero-ingress-assets-'));
  await mkdir(join(root, '_next'), { recursive: true });
  await writeFile(
    join(root, 'index.html'),
    '<script src="/admin/_next/app.js"></script><img src="/icon.png">',
  );
  await writeFile(join(root, '_next/app.js'), 'const assetPath="/admin/_next/";');
  const prefix = '/api/hassio_ingress/trusted-token';
  const server = createServer(async (req, res) => {
    await adminAssets(req, res, root, prefix);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const page = await fetch(base + '/admin/');
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'self'/);
    assert.equal(
      await page.text(),
      `<script src="${prefix}/admin/_next/app.js"></script><img src="${prefix}/icon.png">`,
    );
    assert.equal(
      await (await fetch(base + '/admin/_next/app.js')).text(),
      `const assetPath="${prefix}/admin/_next/";`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
