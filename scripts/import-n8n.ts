import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  readdirSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ConfigSchema } from '../src/adapters/outbound/config.js';
import { Store } from '../src/adapters/outbound/sqlite-store.js';

process.umask(0o077);
const snapshot = resolve(
  process.argv[2] || '../assistant-migration/snapshots/2026-10-15T21-34-04-960Z',
);
const privateDir = resolve(process.argv[3] || '../assistant-migration/private');
if (existsSync('config.json'))
  throw new Error('config.json exists; preserve it and merge configuration deliberately');
const workflows = readdirSync(snapshot)
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(readFileSync(join(snapshot, file), 'utf8')));
const main = workflows.find((w) => w.id === '8ZpEsp3rfYps4NGs');
const support = workflows.find((w) => w.id === 'EG51OtgylSc7Aa2s');
const docs = workflows.find((w) => w.id === 'fsvKlvzHDXrJS3q7');
const rag = workflows.find((w) => w.id === 'V9xEATulXo0qIu0Q');
const node = (workflow: any, name: string) =>
  workflow.nodes.find((n: any) => n.name === name)?.parameters || {};
const credentials = new Map<string, any>();
if (existsSync(privateDir))
  for (const file of readdirSync(privateDir).filter(
    (file) => file.endsWith('.json') && file !== 'legacy-memory.json',
  )) {
    for (const credential of JSON.parse(readFileSync(join(privateDir, file), 'utf8')))
      credentials.set(credential.type, credential.data);
  }
const config = ConfigSchema.parse({});
config.apiKey = randomBytes(32).toString('hex');
config.telegram.webhookSecret = randomBytes(32).toString('hex');
config.telegram.allowedUsers = String(
  node(main, 'Telegram Trigger').additionalFields?.userIds || '',
)
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
config.telegram.token = credentials.get('telegramApi')?.accessToken || '';
const notification = String(node(support, 'Send reminder').chatId || '');
config.telegram.notificationChatId = /^-?\d+$/.test(notification) ? notification : '';
const mappings = {
  calendar: 'googleCalendarOAuth2Api',
  tasks: 'googleTasksOAuth2Api',
  docs: 'googleDocsOAuth2Api',
  drive: 'googleDriveOAuth2Api',
} as const;
for (const [service, type] of Object.entries(mappings)) {
  const credential = credentials.get(type);
  if (!credential) continue;
  config.google.credentials[service as keyof typeof mappings] = {
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
    refreshToken: credential.oauthTokenData?.refresh_token || '',
  };
}
const calendar = node(main, 'Get all Events').calendar;
config.google.calendarId = calendar?.value || calendar || 'primary';
config.google.taskListId = node(main, 'Get many Tasks').task || '@default';
config.google.contextDocumentId = node(main, 'Retrieve Context').documentURL || '';
config.google.documentFolderId = node(docs, 'Create a document').folderId || '';
config.memory.geminiApiKey = credentials.get('googlePalmApi')?.apiKey || '';
config.memory.sharedProfile = 'owner';
config.braveApiKey = credentials.get('braveSearchApi')?.apiKey || '';
config.media.asrUrl = node(main, 'HTTP Request').url || '';
config.media.voice = node(main, 'Convert text to speech').voice || config.media.voice;
config.codex.model = node(main, 'ProDex Agent').model || config.codex.model;
function translate(source: string): string {
  let result = source.replace(/^=/, '').replaceAll('Europe/Spain', '{{timezone}}');
  result = result.replace(/\{\{\s*\$now\s*\}\}/g, '{{now}}');
  result = result.replace(
    /\{\{\s*\$\('Telegram Trigger'\)\.item\.json\.message\.from\.first_name\s*\}\}/g,
    '{{name}}',
  );
  result = result.replace(
    /\{\{\s*\$\('(Retrieve Context|Retrieve Long Term Memories1|Retrieve Long Term Memories2)'\)\.item\.json\.content\s*\}\}/g,
    '{{context}}',
  );
  result = result.replace(/\{\{\s*\$json\.content\s*\}\}/g, '{{context}}');
  result = result.replace(
    /\{\{\s*\$\('Aggregate2?'\)\.item\.json\.categories\s*\}\}/g,
    '{{categories}}',
  );
  result = result.replace(/\{\{\s*\$\('Aggregate'\)\.item\.json\.tags\s*\}\}/g, '{{tags}}');
  result = result.replace(
    /\{\{\s*JSON\.stringify\(\$\('Aggregate'\)\.item\.json\.categories\)\s*\}\}/g,
    '{{categories}}',
  );
  result = result.replace(
    /Log:\s*\{\{\s*\$\('Aggregate'\)\.item\.json\.messages\s*\}\}/g,
    'The conversation log is supplied in the user input.',
  );
  if (/\{\{[^}]*\$/.test(result))
    throw new Error('Untranslated n8n expression in prompt; inspect it before importing');
  return result;
}
const prompts = {
  main: translate(node(main, 'ProDex Agent').systemPrompt || ''),
  morning: translate(node(support, 'ProDex Agent1').systemPrompt || ''),
  reminder: translate(node(support, 'ProDex Agent').systemPrompt || ''),
  consolidation: translate(node(rag, 'AI Agent1').options?.systemMessage || ''),
};
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
writeFileSync('config.json', JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
writeFileSync(join(config.dataDir, 'prompts.json'), JSON.stringify(prompts, null, 2) + '\n', {
  mode: 0o600,
});
chmodSync('config.json', 0o600);
const legacyFile = join(privateDir, 'legacy-memory.json');
if (existsSync(legacyFile)) {
  const store = new Store(config.dataDir);
  let memories = 0,
    history = 0,
    pending = 0;
  for (const record of JSON.parse(readFileSync(legacyFile, 'utf8'))) {
    if (record.kind === 'memory') {
      store.insertMemory(
        config.memory.sharedProfile,
        {
          text: record.text,
          category: record.metadata?.category || 'Ideas',
          tags: record.metadata?.tags || [],
        },
        record.embedding ? JSON.parse(record.embedding) : null,
        `n8n:${record.id}`,
      );
      store.db
        .prepare('UPDATE memories SET created=? WHERE source=?')
        .run(
          record.metadata?.created_at ||
            new Date().toISOString().replace('T', ' ').replace(/Z$/, ''),
          `n8n:${record.id}`,
        );
      memories++;
    } else if (record.kind === 'history') {
      const message = record.message;
      store.addMessage(
        'telegram:' + record.session,
        message.type === 'human' ? 'user' : 'assistant',
        typeof message.data?.content === 'string'
          ? message.data.content
          : JSON.stringify(message.data?.content || message.content || ''),
      );
      history++;
    } else if (record.kind === 'pending') {
      store.addMessage(
        'telegram:' + (config.telegram.allowedUsers[0] || 'owner'),
        'user',
        record.text,
      );
      pending++;
    }
  }
  // Historical chat messages were already handled by n8n; only user_temp needs consolidation.
  store.db.exec(`UPDATE messages SET consolidated=1 WHERE id<=${history}`);
  store.close();
  console.log(
    JSON.stringify({
      importedMemories: memories,
      importedHistory: history,
      importedPending: pending,
    }),
  );
}
console.log(
  'Imported private configuration and prompts. Schedules remain disabled; no Telegram webhook was changed.',
);
