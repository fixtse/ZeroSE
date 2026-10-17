import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/adapters/outbound/config.js';
import { voiceToken } from '../src/application/voice-bridge.js';
import { connectHomeAssistant } from './ha-voice-api.js';

process.umask(0o077);
const satellite =
  process.env.ASSISTANT_VOICE_SATELLITE ||
  'assist_satellite.home_assistant_voice_09ee50_assist_satellite';
if (!/^assist_satellite\.[a-z0-9_]+$/.test(satellite)) throw new Error('Invalid satellite entity');
// Prepare before deploying the new assistant image, so its first startup loads the binding.
if (process.argv.includes('--prepare')) {
  const path = resolve(process.env.ASSISTANT_CONFIG || 'config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw.homeAssistant?.voiceSatellite && raw.homeAssistant.voiceSatellite !== satellite)
    throw new Error('Another voice device is configured; inspect before replacing');
  const dir = resolve('data/voice-backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyFileSync(path, resolve(dir, 'config-' + Date.now() + '.json'));
  raw.homeAssistant = { ...raw.homeAssistant, voiceSatellite: satellite };
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  console.log(
    'Private config backed up and voice binding prepared. Deploy the assistant image before installation.',
  );
  process.exit(0);
}
const config = loadConfig();
if (config.homeAssistant.voiceSatellite !== satellite)
  throw new Error('Run with --prepare before deploying the voice bridge');
const callback = process.env.ASSISTANT_VOICE_CALLBACK_URL || `http://127.0.0.1:${config.port}`;
const url = new URL(callback);
if (
  !['http:', 'https:'].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash
)
  throw new Error('Voice callback must be an HTTP origin');
const probe = await fetch(new URL('/v1/voice/turns/00000000-0000-4000-8000-000000000001', url), {
  headers: { Authorization: `Bearer ${voiceToken(config.apiKey)}` },
  signal: AbortSignal.timeout(5000),
});
if (probe.status !== 404 || ((await probe.json()) as any).error !== 'Voice turn not found')
  throw new Error('Deploy the assistant voice API before installing HA integration');
const container = process.env.ASSISTANT_HA_CONTAINER || 'home-assistant';
const api = async (path: string) => {
  const response = await fetch(config.homeAssistant.url.replace(/\/$/, '') + '/api/' + path, {
    headers: { Authorization: `Bearer ${config.homeAssistant.token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('HA read failed: ' + response.status);
  return response.json() as Promise<any>;
};
const before = await connectHomeAssistant(config);
let snapshot: any;
try {
  snapshot = {
    pipelines: await before.command('assist_pipeline/pipeline/list'),
    device: await api('states/' + satellite),
  };
} finally {
  before.close();
}
const files = Object.fromEntries(
  ['manifest.json', '__init__.py', 'config_flow.py', 'conversation.py', 'client.py'].map((name) => [
    name,
    readFileSync(
      new URL('../integrations/home_assistant/assistant_zero/' + name, import.meta.url),
      'utf8',
    ),
  ]),
);
const script = `
import datetime, json, pathlib, shutil, sys
data = json.load(sys.stdin)
root = pathlib.Path('/config')
backup = root / 'backups' / ('assistant-zero-voice-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
backup.mkdir(parents=True, mode=0o700)
for name in ['configuration.yaml', 'assistant_zero_credentials.yaml', 'custom_components/assistant_zero', '.storage/assist_pipeline.pipelines', '.storage/core.config_entries', '.storage/core.restore_state']:
    path = root / name
    if path.exists():
        target = backup / path.name
        if path.is_dir(): shutil.copytree(path, target)
        else:
            shutil.copy2(path, target)
            target.chmod(0o600)
(backup / 'voice-before.json').write_text(json.dumps(data['snapshot']))
(backup / 'voice-before.json').chmod(0o600)
config = (root / 'configuration.yaml').read_text()
include = 'assistant_zero: !include assistant_zero_credentials.yaml'
if include not in config:
    if any(line.startswith('assistant_zero:') for line in config.splitlines()):
        raise RuntimeError('Existing Zero YAML differs; inspect before replacing')
    config += '\\n' + include + '\\n'
component = root / 'custom_components' / 'assistant_zero'
component.mkdir(parents=True, exist_ok=True)
for name, content in data['files'].items(): (component / name).write_text(content)
(root / 'assistant_zero_credentials.yaml').write_text(json.dumps(data['credentials']))
(root / 'assistant_zero_credentials.yaml').chmod(0o600)
(root / 'configuration.yaml').write_text(config)
print('Installed Zero voice component. Private backup: ' + str(backup))
`;
execFileSync('docker', ['exec', '-i', container, 'python', '-c', script], {
  input: JSON.stringify({
    files,
    snapshot,
    credentials: { url: url.origin, token: voiceToken(config.apiKey), satellite_id: satellite },
  }),
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
// A new Python custom integration cannot be loaded by reloading YAML domains.
execFileSync('docker', ['restart', container], { stdio: 'inherit' });
const deadline = Date.now() + 180000;
let agent: string | undefined;
while (Date.now() < deadline) {
  try {
    const states = await api('states');
    agent = states.find(
      (state: any) =>
        state.entity_id.startsWith('conversation.') &&
        state.attributes.friendly_name === 'Zero' &&
        state.state !== 'unavailable',
    )?.entity_id;
    if (agent) break;
  } catch {
    /* Read-only readiness check only. */
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!agent) throw new Error('Zero agent did not become ready; inspect HA logs before retrying');
const socket = await connectHomeAssistant(config);
try {
  const listing = await socket.command('assist_pipeline/pipeline/list');
  const existing = listing.pipelines.filter((pipeline: any) => pipeline.name === 'Zero');
  if (existing.length > 1) throw new Error('Multiple Zero pipelines; inspect before changing');
  let pipeline = existing[0];
  if (pipeline && pipeline.conversation_engine !== agent)
    throw new Error('Existing Zero pipeline has another agent');
  if (!pipeline) {
    const source = listing.pipelines.find((item: any) => item.id === listing.preferred_pipeline);
    if (!source?.stt_engine || !source?.tts_engine)
      throw new Error('Preferred pipeline has no configured STT/TTS');
    const { id: _id, ...settings } = source;
    pipeline = await socket.command('assist_pipeline/pipeline/create', {
      ...settings,
      name: 'Zero',
      conversation_engine: agent,
      conversation_language: '*',
      prefer_local_intents: false,
    });
  }
  const device = await socket.command('config/entity_registry/get', { entity_id: satellite });
  const devices = await socket.command('assist_pipeline/device/list');
  const selector = devices.find(
    (item: any) => item.device_id === device.device_id,
  )?.pipeline_entity;
  if (!selector) throw new Error('Satellite pipeline selector not found');
  const selection = await api('states/' + selector);
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'python',
      '-c',
      "import json,pathlib,datetime,sys; p=pathlib.Path('/config/backups') / ('zero-selector-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.json'); p.write_text(sys.stdin.read()); p.chmod(0o600)",
    ],
    { input: JSON.stringify({ selection, pipeline }), stdio: ['pipe', 'inherit', 'inherit'] },
  );
  if (selection.state !== 'Zero')
    await socket.command('call_service', {
      domain: 'select',
      service: 'select_option',
      service_data: { entity_id: selector, option: 'Zero' },
    });
  const after = await api('states/' + selector);
  if (after.state !== 'Zero') throw new Error('Satellite did not select Zero');
  console.log(
    JSON.stringify({
      agent,
      pipeline: pipeline.id,
      selector,
      selected: after.state,
      stt: pipeline.stt_engine,
      tts: pipeline.tts_engine,
      language: pipeline.language,
    }),
  );
} finally {
  socket.close();
}
