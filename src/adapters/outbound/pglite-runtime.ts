import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** An OS lock survives event-loop stalls and is released even if Zero crashes.
 * Never unlink the lock file: replacing its inode would permit a second owner.
 */
async function lockDirectory(directory: string) {
  const child = spawn(
    'flock',
    [
      '--exclusive',
      '--nonblock',
      directory + '.zero.lock',
      'sh',
      '-c',
      'printf "locked\\n"; cat >/dev/null',
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  let releasing = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdin.destroy();
      reject(new Error('Timed out acquiring PGlite data directory lock'));
    }, 5000);
    const fail = () => {
      clearTimeout(timer);
      reject(
        new Error('PGlite data directory is already in use, or flock (util-linux) is unavailable'),
      );
    };
    child.once('error', fail);
    child.once('exit', fail);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      child.removeListener('error', fail);
      child.removeListener('exit', fail);
      child.on('error', () => {
        if (!releasing) process.exit(1);
      });
      child.on('exit', () => {
        if (!releasing) {
          console.error(JSON.stringify({ event: 'pglite_lease_lost' }));
          process.exit(1);
        }
      });
      resolve();
    });
  });
  return async () => {
    releasing = true;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.stdin.end();
    });
  };
}

/** Keep existing Drizzle/pg and Mem0 contracts on one embedded PostgreSQL engine.
 * The bridge serializes transactions; the private socket is never published.
 */
export async function openPGlite(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await realpath(directory);
  const unlock = await lockDirectory(directory);
  let socketDirectory: string | undefined;
  let db: import('@electric-sql/pglite').PGlite | undefined;
  let server: import('@electric-sql/pglite-socket').PGLiteSocketServer | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Flush before releasing ownership. On a shutdown failure, keep the OS lock
    // until process exit rather than permitting another engine to touch the files.
    await server?.stop();
    await db?.close();
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
    await unlock();
  };
  try {
    const [{ PGlite }, { vector }, { PGLiteSocketServer }] = await Promise.all([
      import('@electric-sql/pglite'),
      import('@electric-sql/pglite-pgvector'),
      import('@electric-sql/pglite-socket'),
    ]);
    db = await PGlite.create(directory, { extensions: { vector } });
    socketDirectory = await mkdtemp(join(tmpdir(), 'zero-pglite-'));
    server = new PGLiteSocketServer({
      db,
      path: join(socketDirectory, '.s.PGSQL.5432'),
      maxConnections: 32,
    });
    await server.start();
    const url = new URL('postgresql://postgres@localhost/postgres');
    url.searchParams.set('host', socketDirectory);
    return { url: url.href, close };
  } catch (error) {
    await close();
    throw error;
  }
}

let activeRuntime: Awaited<ReturnType<typeof openPGlite>> | undefined;
export async function closeDatabaseRuntime() {
  await activeRuntime?.close();
  activeRuntime = undefined;
}

/** Resolve bootstrap before config loading or any database client is constructed. */
export async function startDatabaseRuntime() {
  const backend = process.env.ASSISTANT_DATABASE_BACKEND || 'postgres';
  if (backend === 'postgres') return undefined;
  if (backend !== 'pglite')
    throw new Error('ASSISTANT_DATABASE_BACKEND must be postgres or pglite');
  if (process.env.ASSISTANT_DATABASE_URL)
    throw new Error(
      'Unset ASSISTANT_DATABASE_URL when choosing PGlite; existing PostgreSQL data is not migrated',
    );
  const runtime = await openPGlite(resolve(process.env.ASSISTANT_DATA_DIR || './data', 'pglite'));
  activeRuntime = runtime;
  process.env.ASSISTANT_DATABASE_URL = runtime.url;
  return runtime;
}
