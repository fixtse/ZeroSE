import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, copyFile, rename, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildRelease } from '../../domain/deployment.js';
import type { DeploymentRunner } from '../../application/deploy-build.js';

export type DeploymentCommand = (args: string[], root: string, image?: string) => Promise<string>;
const execute = promisify(execFile);
const docker: DeploymentCommand = async (args, root, image) => {
  const { stdout } = await execute('docker', args, {
    cwd: root,
    env: { ...process.env, ...(image ? { ASSISTANT_IMAGE: image } : {}) },
    timeout: 600_000,
    maxBuffer: 4_000_000,
  });
  return stdout.trim();
};

/** Host-only adapter. Neither Docker access nor deployment credentials enter the assistant. */
export class DockerDeployment implements DeploymentRunner {
  constructor(
    private root: string,
    private imageRepository: string,
    private run: DeploymentCommand = docker,
  ) {}
  async deploy(release: BuildRelease): Promise<string> {
    if (
      !/^[a-f0-9]{40}$/.test(release.sha) ||
      !/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(this.imageRepository)
    )
      throw new Error('Invalid deployment image');
    const current = await this.run(
      [
        'inspect',
        '--format',
        '{{index .Config.Labels "org.opencontainers.image.revision"}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
        'fixt-assistant',
      ],
      this.root,
    ).catch(() => '');
    if (current === `${release.sha} healthy`) return 'Already running the requested healthy build';
    const tagged = `${this.imageRepository}:sha-${release.sha}`;
    await this.run(['pull', tagged], this.root);
    const labels = JSON.parse(
      await this.run(
        ['image', 'inspect', '--format', '{{json .Config.Labels}}', tagged],
        this.root,
      ),
    );
    if (labels?.['org.opencontainers.image.revision'] !== release.sha)
      throw new Error('Published image revision does not match the completed build');
    const digests: string[] = JSON.parse(
      await this.run(['image', 'inspect', '--format', '{{json .RepoDigests}}', tagged], this.root),
    );
    const image = digests.find(
      (digest) =>
        digest.startsWith(this.imageRepository + '@sha256:') &&
        /^[a-f0-9]{64}$/.test(digest.split('@sha256:')[1]),
    );
    if (!image) throw new Error('Published image has no matching immutable digest');
    await this.run(['compose', 'config', '--quiet'], this.root, image);
    const envPath = join(this.root, '.env');
    const previous = await readFile(envPath, 'utf8');
    const backup = join(this.root, 'data', 'deployment-backups');
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const backupPath = join(backup, `${Date.now()}-${release.runId}.env`);
    await copyFile(envPath, backupPath);
    await chmod(backupPath, 0o600);
    const pinned = /^ASSISTANT_IMAGE=/m.test(previous)
      ? previous.replace(/^ASSISTANT_IMAGE=.*$/gm, `ASSISTANT_IMAGE=${image}`)
      : previous.trimEnd() + `\nASSISTANT_IMAGE=${image}\n`;
    const temporary = envPath + '.deployment-tmp';
    await writeFile(temporary, pinned, { mode: 0o600 });
    await rename(temporary, envPath);
    await this.run(
      ['compose', 'up', '--detach', '--no-deps', '--wait', '--wait-timeout', '120', 'assistant'],
      this.root,
      image,
    );
    const deployed = await this.run(
      [
        'inspect',
        '--format',
        '{{index .Config.Labels "org.opencontainers.image.revision"}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
        'fixt-assistant',
      ],
      this.root,
    );
    if (deployed !== `${release.sha} healthy`)
      throw new Error('Deployment did not reach the expected healthy revision');
    return image;
  }
}
