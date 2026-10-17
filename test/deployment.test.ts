import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { successfulBuild, type BuildRelease } from '../src/domain/deployment.js';
import { DeployBuild } from '../src/application/deploy-build.js';
import { PostgresDeployments } from '../src/adapters/outbound/postgres-deployments.js';
import {
  DockerDeployment,
  type DeploymentCommand,
} from '../src/adapters/outbound/docker-deployment.js';
import {
  createDeploymentServer,
  DeploymentWebhookProxy,
  validDeploymentSignature,
} from '../src/adapters/inbound/deployment-webhook.js';
import { createHttpServer } from '../src/adapters/inbound/http-server.js';
import { fixture, until } from './helpers.js';

const repository = 'fixtse/node-assistant';
const secret = 'test-webhook-secret-at-least-32-characters';
const sha = 'a'.repeat(40);
const release = (number: number): BuildRelease => ({
  runId: String(number),
  attempt: 1,
  runNumber: number,
  sha,
});
const payload = () => ({
  action: 'completed',
  repository: { full_name: repository },
  workflow_run: {
    id: 123,
    run_number: 3,
    run_attempt: 1,
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/images.yaml',
    head_repository: { full_name: repository },
  },
});

test('an allowlisted repository forwards unchanged with independent authentication and never enters the assistant queue', async () => {
  const forwardedSecret = 'independent-tradeese-secret-at-least-32-characters';
  let forwarded = 0,
    enqueued = 0;
  const target = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    assert.equal(req.headers['x-github-event'], 'tradeese_deploy');
    const valid = validDeploymentSignature(
      raw,
      req.headers['x-hub-signature-256'],
      forwardedSecret,
    );
    if (valid) forwarded++;
    res.writeHead(valid ? 202 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(valid ? { status: 'accepted' } : { error: 'Invalid signature' }));
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const receiver = createDeploymentServer(
    secret,
    repository,
    {
      async enqueue() {
        enqueued++;
        return 'accepted';
      },
      async claim() {
        return undefined;
      },
      async finish() {},
    },
    {
      repository: 'fixtse/tradeeSE',
      proxy: new DeploymentWebhookProxy(
        `http://127.0.0.1:${(target.address() as any).port}/github/deploy`,
      ),
    },
  );
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  try {
    const body = ' { "repository": {"full_name":"fixtse/tradeeSE"}, "sha":"test" } ';
    for (const signingSecret of [forwardedSecret, secret]) {
      const response = await fetch(
        `http://127.0.0.1:${(receiver.address() as any).port}/github/deploy`,
        {
          method: 'POST',
          body,
          headers: {
            'X-GitHub-Event': 'tradeese_deploy',
            'X-Hub-Signature-256':
              'sha256=' + createHmac('sha256', signingSecret).update(body).digest('hex'),
          },
        },
      );
      assert.equal(response.status, signingSecret === forwardedSecret ? 202 : 401);
    }
    assert.equal(forwarded, 1);
    assert.equal(enqueued, 0);
  } finally {
    receiver.closeAllConnections();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => receiver.close(() => r())),
      new Promise<void>((r) => target.close(() => r())),
    ]);
  }
});

test('only successful trusted main image builds may become deployment requests', () => {
  assert.deepEqual(successfulBuild(payload(), repository), {
    runId: '123',
    attempt: 1,
    runNumber: 3,
    sha,
  });
  for (const change of [
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { path: '.github/workflows/other.yaml' },
    { head_repository: { full_name: 'fork/repo' } },
    { status: 'in_progress' },
  ])
    assert.equal(
      successfulBuild(
        { ...payload(), workflow_run: { ...payload().workflow_run, ...change } },
        repository,
      ),
      undefined,
    );
  assert.equal(
    successfulBuild({ ...payload(), repository: { full_name: 'other/repo' } }, repository),
    undefined,
  );
  for (const change of [{ head_sha: 'bad' }, { id: 0 }, { run_attempt: 0 }, { run_number: 0 }])
    assert.throws(
      () =>
        successfulBuild(
          { ...payload(), workflow_run: { ...payload().workflow_run, ...change } },
          repository,
        ),
      /Invalid completed build/,
    );
});

test('the public proxy preserves raw GitHub signatures and only signed valid builds are queued', async () => {
  const f = await fixture();
  const accepted: BuildRelease[] = [];
  const receiver = createDeploymentServer(secret, repository, {
    async enqueue(build) {
      accepted.push(build);
      return 'accepted';
    },
    async claim() {
      return undefined;
    },
    async finish() {},
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const receiverUrl = `http://127.0.0.1:${(receiver.address() as any).port}/github/deploy`;
  const proxy = createHttpServer(
    f.config,
    f.store,
    undefined,
    undefined,
    new DeploymentWebhookProxy(receiverUrl),
  );
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const url = `http://127.0.0.1:${(proxy.address() as any).port}/github/deploy`;
  const post = (body: string, event = 'workflow_run', valid = true) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': 'delivery-test',
        'X-Hub-Signature-256':
          'sha256=' +
          createHmac('sha256', valid ? secret : 'wrong')
            .update(body)
            .digest('hex'),
      },
      body,
    });
  try {
    assert.equal((await post(JSON.stringify(payload()), 'workflow_run', false)).status, 401);
    assert.equal(accepted.length, 0);
    assert.equal((await post(' { "zen": "test" } ', 'ping')).status, 200);
    assert.equal((await post(JSON.stringify(payload()), 'push')).status, 200);
    assert.equal(accepted.length, 0);
    assert.equal((await post(JSON.stringify(payload(), null, 2))).status, 202);
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0], { runId: '123', attempt: 1, runNumber: 3, sha });
    assert.equal((await post('{invalid')).status, 400);
    for (const url of [
      'https://example.com/github/deploy',
      'http://127.0.0.1:8790/other',
      'http://user:password@127.0.0.1/github/deploy',
    ])
      assert.throws(() => new DeploymentWebhookProxy(url), /loopback/);
  } finally {
    proxy.closeAllConnections();
    receiver.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => proxy.close(() => r())),
      new Promise<void>((r) => receiver.close(() => r())),
    ]);
    await f.close();
  }
});

test('deployment receipts deduplicate, reject stale builds, serialize jobs, and never replay interrupted deployments', async () => {
  const f = await fixture();
  let store = new PostgresDeployments(f.store.pool);
  await store.initialize();
  try {
    assert.equal(await store.enqueue(release(1)), 'accepted');
    assert.equal(await store.enqueue(release(1)), 'duplicate');
    assert.equal(await store.enqueue(release(3)), 'accepted');
    assert.equal(await store.enqueue(release(2)), 'stale');
    const first = (await store.claim())!;
    assert.equal(first.runNumber, 1);
    await store.close();
    store = new PostgresDeployments(f.store.pool);
    await store.initialize();
    assert.equal(
      (await f.store.pool.query('SELECT status FROM deployment_runs WHERE id=$1', [first.id]))
        .rows[0].status,
      'failed',
    );
    const next = (await store.claim())!;
    assert.equal(next.runNumber, 3);
    await store.finish(next.id, 'failed', 'Uncertain deployment');
    assert.equal(await store.enqueue(release(3)), 'duplicate');
    assert.equal(await store.claim(), undefined);
  } finally {
    await store.close();
    await f.close();
  }
});

test('Docker deployment validates the revision, pins the digest, preserves private config, and only recreates the assistant', async () => {
  const f = await fixture();
  const commands: string[][] = [];
  const imageRepository = 'ghcr.io/fixtse/node-assistant';
  const pinned = imageRepository + '@sha256:' + 'b'.repeat(64);
  const env =
    'ASSISTANT_IMAGE=' +
    imageRepository +
    ':latest\nASSISTANT_POSTGRES_PASSWORD=test-private-password\n';
  await writeFile(join(f.dir, '.env'), env, { mode: 0o600 });
  let deployed = false,
    mismatch = false;
  const run: DeploymentCommand = async (args, _root, image) => {
    commands.push(args);
    if (args[0] === 'inspect') return `${deployed ? sha : 'c'.repeat(40)} healthy`;
    if (args.includes('{{json .Config.Labels}}'))
      return JSON.stringify({ 'org.opencontainers.image.revision': mismatch ? 'wrong' : sha });
    if (args.includes('{{json .RepoDigests}}')) return JSON.stringify([pinned]);
    if (args[0] === 'compose') {
      assert.equal(image, pinned);
      if (args[1] === 'up') deployed = true;
    }
    return '';
  };
  const runner = new DockerDeployment(f.dir, imageRepository, run);
  try {
    assert.equal(await runner.deploy(release(1)), pinned);
    assert.match(
      await readFile(join(f.dir, '.env'), 'utf8'),
      new RegExp('ASSISTANT_IMAGE=' + pinned),
    );
    assert.match(
      await readFile(join(f.dir, '.env'), 'utf8'),
      /ASSISTANT_POSTGRES_PASSWORD=test-private-password/,
    );
    const backupDir = join(f.dir, 'data', 'deployment-backups');
    const backup = join(backupDir, (await readdir(backupDir))[0]);
    assert.equal(await readFile(backup, 'utf8'), env);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    assert.deepEqual(
      commands.find((args) => args[0] === 'compose' && args[1] === 'up'),
      ['compose', 'up', '--detach', '--no-deps', '--wait', '--wait-timeout', '120', 'assistant'],
    );
    assert(!commands.some((args) => args.includes('build') || args.includes('--build')));
    const before = commands.length;
    assert.match(await runner.deploy(release(1)), /Already running/);
    assert.equal(commands.length, before + 1);
    deployed = false;
    mismatch = true;
    const upBefore = commands.filter((args) => args[1] === 'up').length;
    await assert.rejects(runner.deploy(release(2)), /revision does not match/);
    assert.equal(commands.filter((args) => args[1] === 'up').length, upBefore);
  } finally {
    await f.close();
  }
});

test('the host worker records results before notifications and never retries failed deployment or notification actions', async () => {
  const f = await fixture();
  const store = new PostgresDeployments(f.store.pool);
  await store.initialize();
  const executed: number[] = [],
    sent: string[] = [];
  const worker = new DeployBuild(
    store,
    {
      async deploy(build) {
        executed.push(build.runNumber);
        if (build.runNumber === 1) throw new Error('Deployment uncertain');
        return 'healthy digest';
      },
    },
    {
      async send(text) {
        const running = (
          await f.store.pool.query("SELECT count(*) FROM deployment_runs WHERE status='running'")
        ).rows[0].count;
        assert.equal(running, '0');
        sent.push(text);
        if (sent.length === 2) throw new Error('Notification uncertain');
      },
    },
    repository,
  );
  try {
    await store.enqueue(release(1));
    await store.enqueue(release(2));
    worker.start();
    await until(() => sent.length === 2);
    assert.deepEqual(executed, [1, 2]);
    assert.match(sent[0], /No se pudo completar/);
    assert.match(sent[1], /actualizado y saludable/);
    assert.deepEqual(
      (await f.store.pool.query('SELECT status FROM deployment_runs ORDER BY id')).rows.map(
        (r) => r.status,
      ),
      ['failed', 'done'],
    );
    assert.equal(await store.enqueue(release(1)), 'duplicate');
    assert.equal(await store.claim(), undefined);
  } finally {
    await worker.close();
    await store.close();
    await f.close();
  }
});
