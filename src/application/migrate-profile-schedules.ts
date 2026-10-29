import type { Config } from '../domain/config.js';
import { telegramSession } from '../domain/access.js';
import { localClock } from '../domain/time.js';
import type { AccessRepository } from './access.js';
import { scopedConfig } from './access.js';
import type { ConversationStore } from './ports.js';
import type { MorningTriggerPort } from './morning-triggers.js';
import { importMorningTrigger } from './morning-triggers.js';
import { profileNotifications, morningKey } from './profile-notifications.js';

/** Import the retired installation-wide options once; runtime never reads them. */
export async function migrateProfileSchedules(
  source: unknown,
  config: Config,
  repository: AccessRepository,
  store: ConversationStore,
  triggers: MorningTriggerPort,
) {
  const schedules = (
    source as {
      schedules?: { enabled?: boolean; morning?: string; reset?: string; eventReminders?: boolean };
    }
  )?.schedules;
  if (!schedules) return;
  for (let offset = 0; ; offset += 100) {
    const page = await repository.profiles('', offset, 100);
    for (const profile of page.items) {
      const recipient =
        profile.bot === 'zero' && profile.chatId === config.telegram.notificationChatId;
      const notifications = profileNotifications(profile);
      const original = profile.notifications;
      if (!original) {
        notifications.reset = {
          enabled: schedules.enabled === true,
          time: schedules.reset || '04:00',
        };
        if (recipient && schedules.enabled) {
          notifications.eventReminders = schedules.eventReminders === true;
          if (schedules.morning)
            notifications.morning = {
              ...notifications.morning,
              mode: 'time',
              time: schedules.morning,
            };
          else {
            notifications.morning = {
              ...notifications.morning,
              mode: 'entity',
              entity: '',
              state: 'off',
            };
            profile.morningImportAutomation = 'assistant_morning_on_wakeup';
            profile.morningCallbackDefault = true;
          }
        }
      } else if (!original.reset) {
        notifications.reset = {
          enabled: schedules.enabled === true,
          time: schedules.reset || '04:00',
        };
      }
      profile.notifications = notifications;
      await repository.saveProfile(profile);
      // Retain today's delivered marker without replaying an old job.
      if (recipient) {
        const { day } = localClock(new Date(), profile.timezone || config.timezone);
        if (await store.scheduled('morning:' + day))
          await store.markScheduled(morningKey(telegramSession(profile.bot, profile.chatId), day));
      }
      await importMorningTrigger(profile, scopedConfig(config, profile), repository, triggers);
    }
    if (!page.items.length || offset + page.items.length >= page.total) break;
  }
}
