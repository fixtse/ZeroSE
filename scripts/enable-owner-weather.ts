import { createDatabase } from '../src/adapters/outbound/database.js';
import pg from 'pg';
import { loadRuntimeConfig } from '../src/adapters/outbound/runtime-config.js';
import { PostgresAccess } from '../src/adapters/outbound/postgres-access.js';
import { PostgresRules } from '../src/adapters/outbound/postgres-rules.js';
import { HomeAssistantRuleScheduler } from '../src/adapters/outbound/ha-rule-scheduler.js';
import { NotificationRules } from '../src/application/notification-rules.js';
import { scopedConfig } from '../src/application/access.js';

// Explicit activation of the owner's built-in rule. Never sends a test notification.
const config = await loadRuntimeConfig();
const chat = config.telegram.allowedUsers[0] || config.telegram.notificationChatId;
if (!chat) throw new Error('Configure the original owner Telegram chat first');
const session = 'telegram:' + chat;
const pool = new pg.Pool({ connectionString: config.database.url, max: 2 });
try {
  const access = new PostgresAccess(
    createDatabase(pool),
    process.env.ASSISTANT_SECRETS_KEY || config.apiKey,
  );
  const repository = new PostgresRules(createDatabase(pool));
  // The live worker owns recovery; this explicit installer must not mark in-flight writes uncertain.
  await repository.initialize(false);
  const rules = new NotificationRules(repository, async (candidate) => {
    const profile = await access.profile('zero', chat);
    const scoped = profile ? scopedConfig(config, profile) : config;
    return {
      enabled:
        candidate === session &&
        !!profile?.owner &&
        !!profile.enabled &&
        profile.capabilities.includes('homeAssistant') &&
        config.telegram.transport !== 'disabled',
      scheduler: new HomeAssistantRuleScheduler(scoped.homeAssistant),
    };
  });
  const rule = await rules.ensureOwnerWeather(session);
  if (rule?.scheduler_state !== 'installed')
    throw new Error(
      `Owner weather rule ${rule?.id} has state ${rule?.scheduler_state}; inspect it before making another change`,
    );
  const observed = await rules.inspect(session, rule.id);
  console.log(
    JSON.stringify({
      id: rule.id,
      status: rule.status,
      cooldown_seconds: rule.cooldown_seconds,
      sleep_entity: rule.condition?.source === 'weather' ? rule.condition.sleep_entity : undefined,
      hourly_updates:
        rule.condition?.source === 'weather' ? rule.condition.hourly_updates === true : false,
      home_assistant: observed.home_assistant,
    }),
  );
} finally {
  await pool.end();
}
