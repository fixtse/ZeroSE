import { createDatabase } from '../src/adapters/outbound/database.js';
import { resolve } from 'node:path';
import { assistantIdPattern } from '../src/domain/access.js';
import pg from 'pg';
import { loadRuntimeConfig } from '../src/adapters/outbound/runtime-config.js';
import { Media } from '../src/adapters/outbound/media.js';
import { Telegram } from '../src/adapters/outbound/telegram.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresDeployments } from '../src/adapters/outbound/postgres-deployments.js';
import { DockerDeployment } from '../src/adapters/outbound/docker-deployment.js';
import {
  createDeploymentServer,
  DeploymentWebhookProxy,
} from '../src/adapters/inbound/deployment-webhook.js';
import { DeployBuild } from '../src/application/deploy-build.js';

process.umask(0o077);
const root = resolve(process.env.ASSISTANT_DEPLOY_ROOT || process.cwd());
process.loadEnvFile(resolve(root, '.env'));
const repository = process.env.ASSISTANT_DEPLOY_REPOSITORY || 'fixtse/zero-assistant';
if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository))
  throw new Error('Invalid deployment repository');
const secret = process.env.ASSISTANT_DEPLOY_SECRET || '';
if (secret.length < 32)
  throw new Error('Deployment webhook secret must have at least 32 characters');
const port = Number(process.env.ASSISTANT_DEPLOY_PORT || 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid deployment port');
const chat = process.env.ASSISTANT_DEPLOY_NOTIFY_CHAT || '';
const notificationAssistant = process.env.ASSISTANT_DEPLOY_NOTIFY_ASSISTANT || 'zero';
if (!new RegExp('^' + assistantIdPattern + '$').test(notificationAssistant))
  throw new Error('Invalid deployment notification assistant');
if (!/^-?\d+$/.test(chat))
  throw new Error('Set ASSISTANT_DEPLOY_NOTIFY_CHAT to the intended notification chat');
if (!process.env.ASSISTANT_DATABASE_URL) {
  const database = new URL('postgresql://assistant@127.0.0.1/assistant');
  database.password = process.env.ASSISTANT_POSTGRES_PASSWORD || '';
  database.port = process.env.ASSISTANT_POSTGRES_PORT || '55432';
  process.env.ASSISTANT_DATABASE_URL = database.href;
}
const config = await loadRuntimeConfig();
const pool = new pg.Pool({
  connectionString: config.database.url,
  max: 4,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
pool.on('error', () => console.error(JSON.stringify({ event: 'deployment_database_failed' })));
const access = new PostgresAccess(
  createDatabase(pool),
  process.env.ASSISTANT_SECRETS_KEY || config.apiKey,
);
const store = new PostgresDeployments(createDatabase(pool));
await store.initialize();
const worker = new DeployBuild(
  store,
  new DockerDeployment(root, `ghcr.io/${repository.toLowerCase()}`),
  {
    async send(text) {
      const bot = (await access.bots()).find((bot) => bot.id === notificationAssistant);
      if (!bot?.enabled || !bot.token)
        throw new Error('Configured deployment notification bot is unavailable');
      const telegram = new Telegram(
        { ...config, telegram: { ...config.telegram, token: bot.token } },
        new Media(config),
        notificationAssistant,
      );
      await telegram.send(chat, text, AbortSignal.timeout(15_000));
    },
  },
  repository,
);
const forwardRepository = process.env.ASSISTANT_DEPLOY_FORWARD_REPOSITORY;
const forwardUrl = process.env.ASSISTANT_DEPLOY_FORWARD_URL;
if (
  !!forwardRepository !== !!forwardUrl ||
  (forwardRepository && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(forwardRepository))
)
  throw new Error('Configure both a valid forwarding repository and a loopback webhook URL');
const server = createDeploymentServer(
  secret,
  repository,
  store,
  forwardRepository && forwardUrl
    ? { repository: forwardRepository, proxy: new DeploymentWebhookProxy(forwardUrl) }
    : undefined,
);
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'deployment_webhook_started', port, repository }));
  worker.start();
});
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await worker.close();
  await store.close();
  await pool.end();
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
