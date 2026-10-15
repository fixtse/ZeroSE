import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { loadConfig } from '../src/adapters/outbound/config.js';
const config = loadConfig();
mkdirSync(config.codex.home, { recursive: true, mode: 0o700 });
const child = spawn(config.codex.command, [...config.codex.args, 'login', '--device-auth'], {
  env: { PATH: process.env.PATH, HOME: config.codex.home, CODEX_HOME: config.codex.home },
  stdio: 'inherit',
});
child.on('exit', (code) => {
  process.exitCode = code || 0;
});
child.on('error', () => {
  console.error('Could not start Codex login');
  process.exitCode = 1;
});
