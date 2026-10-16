import { createServer, type IncomingMessage } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { successfulBuild } from '../../domain/deployment.js';
import type { DeploymentStore } from '../../application/deploy-build.js';

export async function deploymentBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Webhook exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function validDeploymentSignature(body: Buffer, signature: unknown, secret: string) {
  if (!secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
export function createDeploymentServer(secret: string, repository: string, store: DeploymentStore) {
  if (secret.length < 32)
    throw new Error('Deployment webhook secret must have at least 32 characters');
  return createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/github/deploy')
      return send(404, { error: 'Not found' });
    try {
      const raw = await deploymentBody(req);
      if (!validDeploymentSignature(raw, req.headers['x-hub-signature-256'], secret))
        return send(401, { error: 'Invalid signature' });
      if (req.headers['x-github-event'] === 'ping') return send(200, { ok: true });
      if (req.headers['x-github-event'] !== 'workflow_run') return send(200, { ignored: true });
      const release = successfulBuild(JSON.parse(raw.toString('utf8')), repository);
      if (!release) return send(200, { ignored: true });
      const status = await store.enqueue(release);
      send(status === 'accepted' ? 202 : 200, { status });
    } catch {
      send(400, { error: 'Webhook could not be accepted' });
    }
  });
}

/** Forward raw signed GitHub deliveries to the separate loopback host worker. */
export class DeploymentWebhookProxy {
  constructor(private url: string) {
    const target = new URL(url);
    if (
      target.protocol !== 'http:' ||
      target.hostname !== '127.0.0.1' ||
      target.pathname !== '/github/deploy' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      throw new Error('Deployment webhook target must be an HTTP loopback /github/deploy URL');
  }
  async forward(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const raw = await deploymentBody(req);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    for (const name of ['x-hub-signature-256', 'x-github-event', 'x-github-delivery']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: new Uint8Array(raw),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  }
}
