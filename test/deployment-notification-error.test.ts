import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentNotificationError } from '../src/application/deployment-notification-error.js';
import { RemoteError } from '../src/adapters/outbound/http.js';

test('deployment notification diagnostics expose HTTP, timeout, configuration and network failures', () => {
  assert.equal(deploymentNotificationError(new RemoteError('Telegram', 403)).httpStatus, 403);
  assert.equal(
    deploymentNotificationError(new Error('Configured deployment notification bot is unavailable'))
      .message,
    'Configured deployment notification bot is unavailable',
  );
  assert.equal(
    deploymentNotificationError(new DOMException('private URL', 'TimeoutError')).message,
    'Telegram notification timed out',
  );
  assert.equal(
    deploymentNotificationError(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('private'), { code: 'ECONNRESET' }),
      }),
    ).networkCode,
    'ECONNRESET',
  );
});

test('deployment notification diagnostics never serialize arbitrary errors or secrets', () => {
  const secret = 'https://api.telegram.org/bot123:private-token/sendMessage';
  const error = Object.assign(new Error(secret, { cause: { code: secret } }), {
    name: secret,
    status: secret,
    stack: secret,
  });
  for (const value of [error, secret, { token: secret }, null]) {
    assert(!JSON.stringify(deploymentNotificationError(value)).includes(secret));
  }
});

test('notification failure logs identify the build and preserve the successful deployment result', async (t) => {
  const { DeployBuild } = await import('../src/application/deploy-build.js');
  const logs: string[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  let claimed = false;
  let result = '';
  const worker = new DeployBuild(
    {
      async enqueue() {
        return 'accepted';
      },
      async claim() {
        if (claimed) return undefined;
        claimed = true;
        return { id: '93', runId: '123', attempt: 1, runNumber: 1, sha: 'a'.repeat(40) };
      },
      async finish(_id, status) {
        result = status;
      },
    },
    {
      async deploy() {
        return 'healthy';
      },
    },
    {
      async send() {
        throw new RemoteError('Telegram', 403);
      },
    },
    'fixtse/zero-assistant',
  );
  worker.start();
  await worker.close();
  assert.equal(result, 'done');
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), {
    event: 'deployment_notification_failed',
    job: '93',
    runId: '123',
    attempt: 1,
    sha: 'a'.repeat(40),
    status: 'done',
    error: { type: 'Error', message: 'Telegram returned HTTP 403', httpStatus: 403 },
  });
});
