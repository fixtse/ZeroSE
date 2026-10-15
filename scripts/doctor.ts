import { loadConfig } from '../src/adapters/outbound/config.js';
import { Google } from '../src/adapters/outbound/google.js';
import { HomeAssistant } from '../src/adapters/outbound/home-assistant.js';
import { GeminiEmbeddings } from '../src/adapters/outbound/gemini-embeddings.js';
import { Telegram } from '../src/adapters/outbound/telegram.js';
import { Media } from '../src/adapters/outbound/media.js';
const config = loadConfig(),
  google = new Google(config.google, config.timezone),
  ha = new HomeAssistant(config.homeAssistant),
  telegram = new Telegram(config, new Media(config));
const checks: [string, () => Promise<unknown>][] = [
  [
    'google_calendar',
    async () => ({
      events: (
        await google.events(
          new Date().toISOString(),
          new Date(Date.now() + 86400_000).toISOString(),
        )
      ).length,
    }),
  ],
  ['google_tasks', async () => ({ pendingTasks: (await google.tasks()).length })],
  ['google_context', async () => ({ characters: (await google.context()).length })],
  [
    'telegram_identity',
    async () => {
      const bot = await telegram.call('getMe', {});
      return { username: bot.username };
    },
  ],
  [
    'telegram_webhook',
    async () => {
      const webhook = await telegram.call('getWebhookInfo', {});
      return { configured: !!webhook.url };
    },
  ],
  [
    'gemini_embeddings',
    async () => ({
      dimensions: (
        await new GeminiEmbeddings(config.memory).embed(
          'Verificación de memoria',
          'SEMANTIC_SIMILARITY',
        )
      ).length,
    }),
  ],
];
if (config.homeAssistant.token)
  checks.push(
    ['home_assistant_sensors', async () => ({ entities: (await ha.sensors()).length })],
    ['home_assistant_shopping', async () => ({ items: (await ha.shopping()).length })],
  );
else console.log(JSON.stringify({ check: 'home_assistant', status: 'not_configured' }));
const results = await Promise.allSettled(
  checks.map(async ([name, run]) => ({ check: name, result: await run() })),
);
for (let index = 0; index < results.length; index++) {
  const result = results[index];
  if (result.status === 'fulfilled') console.log(JSON.stringify({ ...result.value, status: 'ok' }));
  else {
    console.log(
      JSON.stringify({
        check: checks[index][0],
        status: 'failed',
        error: result.reason instanceof Error ? result.reason.message : 'Check failed',
      }),
    );
    process.exitCode = 1;
  }
}
