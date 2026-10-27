import { randomBytes, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Publish a complete key atomically so concurrent first starts share one identity. */
export function bootstrapKey(dataDir: string): string {
  const file = join(dataDir, 'bootstrap.key');
  try {
    return readKey();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = join(dataDir, '.bootstrap-' + randomUUID());
  writeFileSync(temporary, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  try {
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
  return readKey();

  function readKey() {
    const key = readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error('Invalid persisted bootstrap key; restore it from your private backup.');
    return key;
  }
}
