import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/adapters/outbound/config.js';
import { rulesToken } from '../src/application/rules-auth.js';
import { jsonRequest, jsonBody } from '../src/adapters/outbound/http.js';

// Only explicitly running this installer changes HA; normal assistant startup never does.
const config = loadConfig();
if (!config.homeAssistant.token) throw new Error('Configure Home Assistant credentials first');
const container = process.env.ASSISTANT_HA_CONTAINER || 'home-assistant';
const callback =
  process.env.ASSISTANT_RULES_CALLBACK_URL || `http://127.0.0.1:${config.port}/v1/triggers/rules`;
const url = new URL(callback);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
  throw new Error('Invalid callback URL');
const curl = `url = ${JSON.stringify(url.href)}\nrequest = "POST"\nheader = "Authorization: Bearer ${rulesToken(config.apiKey)}"\nmax-time = 10\nsilent\nfail\n`;
const automation = `
# BEGIN assistant-rules-heartbeat
- id: assistant_rules_heartbeat
  alias: Assistant reminders and conditional alerts heartbeat
  description: Evaluate durable assistant rules; no Telegram messages are sent by this automation.
  triggers:
    - trigger: time_pattern
      seconds: "/10"
  actions:
    - action: shell_command.assistant_rules_heartbeat
  mode: single
# END assistant-rules-heartbeat
`;
const script = `
import datetime, json, pathlib, shutil, sys
data = json.load(sys.stdin)
root = pathlib.Path('/config')
backup = root / 'backups' / ('assistant-rules-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
backup.mkdir(parents=True, mode=0o700)
for name in ['configuration.yaml', 'automations.yaml', 'assistant_rules.curl']:
    p = root / name
    if p.exists():
        shutil.copy2(p, backup / name)
        (backup / name).chmod(0o600)
config = (root / 'configuration.yaml').read_text()
command = '  assistant_rules_heartbeat: curl --config /config/assistant_rules.curl --output /dev/null'
if command not in config:
    if 'assistant_rules_heartbeat:' in config: raise RuntimeError('Existing shell command has a different definition')
    if '\\nshell_command:\\n' not in config: raise RuntimeError('Expected existing shell_command mapping')
    config = config.replace('\\nshell_command:\\n', '\\nshell_command:\\n' + command + '\\n', 1)
automations = (root / 'automations.yaml').read_text()
start, end = '# BEGIN assistant-rules-heartbeat', '# END assistant-rules-heartbeat'
if start in automations:
    a, b = automations.index(start), automations.index(end) + len(end)
    automations = automations[:a] + data['automation'].strip() + automations[b:]
else:
    if 'id: assistant_rules_heartbeat' in automations: raise RuntimeError('Automation ID already exists')
    if automations.strip() == '[]': automations = ''
    automations = automations.rstrip() + '\\n' + data['automation']
(root / 'assistant_rules.curl').write_text(data['curl'])
(root / 'assistant_rules.curl').chmod(0o600)
(root / 'configuration.yaml').write_text(config)
(root / 'automations.yaml').write_text(automations)
print('Installed heartbeat; private backup: ' + str(backup))
`;
execFileSync('docker', ['exec', '-i', container, 'python3', '-c', script], {
  input: JSON.stringify({ automation, curl }),
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
for (const domain of ['shell_command', 'automation']) {
  await jsonRequest(
    config.homeAssistant.url.replace(/\/$/, '') + `/api/services/${domain}/reload`,
    {
      method: 'POST',
      ...jsonBody({}),
      headers: {
        Authorization: `Bearer ${config.homeAssistant.token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    },
    'Home Assistant reload',
  );
}
console.log(
  'Reloaded shell commands and automations without restarting Home Assistant or the assistant. Heartbeats take effect when the new assistant version is deployed.',
);
