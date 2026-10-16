import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/adapters/outbound/config.js';
import { rulesToken } from '../src/application/rules-auth.js';
import { jsonRequest } from '../src/adapters/outbound/http.js';

// Explicit infrastructure installation only; normal assistant startup never changes HA files.
const config = loadConfig();
if (!config.homeAssistant.token) throw new Error('Configure Home Assistant credentials first');
const container = process.env.ASSISTANT_HA_CONTAINER || 'home-assistant';
const callback =
  process.env.ASSISTANT_RULES_CALLBACK_URL ||
  `http://127.0.0.1:${config.port}/v1/triggers/rule-events`;
const url = new URL(callback);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
  throw new Error('Invalid callback URL');
const files = Object.fromEntries(
  ['manifest.json', '__init__.py', 'engine.py'].map((name) => [
    name,
    readFileSync(
      new URL('../integrations/home_assistant/assistant_rules/' + name, import.meta.url),
      'utf8',
    ),
  ]),
);
const credentials = JSON.stringify({
  callback_url: url.href,
  callback_token: rulesToken(config.apiKey),
});
const script = `
import datetime, json, pathlib, shutil, sys
data = json.load(sys.stdin)
root = pathlib.Path('/config')
backup = root / 'backups' / ('assistant-rules-events-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
backup.mkdir(parents=True, mode=0o700)
for name in ['configuration.yaml', 'automations.yaml', 'assistant_rules.curl', 'assistant_rules_credentials.yaml', 'custom_components/assistant_rules']:
    path = root / name
    if path.exists():
        target = backup / path.name
        if path.is_dir(): shutil.copytree(path, target)
        else:
            shutil.copy2(path, target)
            target.chmod(0o600)
config = (root / 'configuration.yaml').read_text()
command = '  assistant_rules_heartbeat: curl --config /config/assistant_rules.curl --output /dev/null'
config = config.replace(command + '\\n', '')
include = 'assistant_rules: !include assistant_rules_credentials.yaml'
if include not in config:
    if '\\nassistant_rules:' in config: raise RuntimeError('Existing assistant_rules configuration differs; inspect it before installation')
    config += '\\n' + include + '\\n'
automations = (root / 'automations.yaml').read_text()
start, end = '# BEGIN assistant-rules-heartbeat', '# END assistant-rules-heartbeat'
if start in automations:
    a, b = automations.index(start), automations.index(end) + len(end)
    automations = automations[:a] + automations[b:]
    if not automations.strip(): automations = '[]\\n'
component = root / 'custom_components' / 'assistant_rules'
component.mkdir(parents=True, exist_ok=True)
for name, content in data['files'].items():
    (component / name).write_text(content)
(root / 'assistant_rules_credentials.yaml').write_text(data['credentials'])
(root / 'assistant_rules_credentials.yaml').chmod(0o600)
(root / 'configuration.yaml').write_text(config)
(root / 'automations.yaml').write_text(automations)
(root / 'assistant_rules.curl').unlink(missing_ok=True)
print('Installed event-driven integration and removed heartbeat. Private backup: ' + str(backup))
`;
execFileSync('docker', ['exec', '-i', container, 'python3', '-c', script], {
  input: JSON.stringify({ files, credentials }),
  stdio: ['pipe', 'inherit', 'inherit'],
});
execFileSync(
  'docker',
  [
    'exec',
    container,
    'python',
    '-m',
    'homeassistant',
    '--script',
    'check_config',
    '--config',
    '/config',
  ],
  { stdio: 'inherit' },
);
// Loading new Python integration code requires a HA restart. The assistant is not restarted.
execFileSync('docker', ['restart', container], { stdio: 'inherit' });
const until = Date.now() + 180000;
let ready = false;
while (Date.now() < until) {
  try {
    const result = await jsonRequest(
      config.homeAssistant.url.replace(/\/$/, '') + '/api/assistant_rules',
      {
        headers: { Authorization: `Bearer ${config.homeAssistant.token}` },
        signal: AbortSignal.timeout(3000),
      },
      'Home Assistant event scheduler',
    );
    if (result.protocol === 2 && result.ready) {
      ready = true;
      break;
    }
  } catch {
    /* Read-only startup probe; never retry mutations or callback delivery. */
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready)
  throw new Error(
    'Home Assistant did not report the event scheduler ready; inspect its logs before another installation',
  );
console.log(
  'Home Assistant event scheduler is ready. No heartbeat or periodic callback remains. The assistant was not restarted.',
);
