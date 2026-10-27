import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const folder = 'drizzle';
const before = new Set(existsSync(folder) ? readdirSync(folder) : []);
const result = spawnSync('pnpm', ['exec', 'drizzle-kit', 'generate', ...process.argv.slice(2)], {
  encoding: 'utf8',
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (
  result.error ||
  result.status !== 0 ||
  /\b(?:TypeError|Error):/.test((result.stdout || '') + (result.stderr || ''))
)
  throw new Error('drizzle-kit did not generate valid migrations');
if (!existsSync(join(folder, 'meta', '_journal.json')))
  throw new Error('drizzle-kit did not create a migration journal');
for (const name of readdirSync(folder).filter(
  (name) => name.endsWith('.sql') && !before.has(name),
)) {
  const file = join(folder, name);
  // The runtime and tests select their own schema through search_path. Preserve that isolation.
  let sql = readFileSync(file, 'utf8').replace(/REFERENCES "public"\./g, 'REFERENCES ');
  if (name.startsWith('0000_')) {
    if (!sql.includes('CREATE TABLE'))
      throw new Error('The initial migration must contain the generated tables');
    sql =
      '-- pgvector must exist before the generated vector column.\nCREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;\n--> statement-breakpoint\n' +
      sql;
  }
  writeFileSync(file, sql);
}
