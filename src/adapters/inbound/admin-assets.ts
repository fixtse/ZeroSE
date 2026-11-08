import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
/** Next exports a static UI; all authority stays behind the existing authenticated APIs. */
export async function adminAssets(
  req: IncomingMessage,
  res: ServerResponse,
  root = resolve('web/out'),
  ingressPath = '',
) {
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (path !== '/admin' && !path.startsWith('/admin/')) return false;
  let relative: string;
  try {
    relative = decodeURIComponent(path.slice('/admin'.length));
  } catch {
    return false;
  }
  const file = resolve(
    root,
    '.' + (relative || '/') + (relative.endsWith('/') || !relative ? 'index.html' : ''),
  );
  if (!file.startsWith(root + sep)) return false;
  try {
    let value = await readFile(file);
    if (ingressPath && ['.html', '.js', '.css'].includes(extname(file)))
      value = Buffer.from(
        value
          .toString('utf8')
          .replaceAll('/admin/', ingressPath + '/admin/')
          .replaceAll('/icon.png', ingressPath + '/icon.png'),
      );
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src blob:; base-uri 'none'; frame-ancestors ${ingressPath ? "'self'" : "'none'"}; form-action 'self'`,
    });
    res.end(req.method === 'HEAD' ? undefined : value);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Admin UI not found. Run pnpm build.');
  }
  return true;
}
