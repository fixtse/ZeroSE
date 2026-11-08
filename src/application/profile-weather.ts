import type { Config } from '../domain/config.js';
import { telegramSession, type AccessProfile } from '../domain/access.js';
import { scopedConfig, type AccessRepository } from './access.js';
import type { NotificationRules } from './notification-rules.js';
import { profileNotifications } from './profile-notifications.js';

/** Weather subscriptions are internal and follow profile preferences, including non-owners. */
export async function provisionProfileWeather(
  repository: Pick<AccessRepository, 'profiles'>,
  config: Config,
  rules: Pick<NotificationRules, 'ensureProfileWeather'>,
  failed: (profile: AccessProfile) => void,
) {
  for (let offset = 0; ; offset += 100) {
    const page = await repository.profiles('', offset, 100);
    for (const profile of page.items) {
      if (
        !profile.enabled ||
        profile.chatId.startsWith('ha:') ||
        !profile.capabilities.includes('homeAssistant') ||
        profileNotifications(profile).weather?.mode === 'off' ||
        !scopedConfig(config, profile).homeAssistant.token
      )
        continue;
      try {
        await rules.ensureProfileWeather(
          telegramSession(profile.bot, profile.chatId),
          profile.owner ? 'input_boolean.dormir' : null,
        );
      } catch {
        // Continue other profiles without retrying an uncertain external write.
        failed(profile);
      }
    }
    if (offset + page.items.length >= page.total || !page.items.length) break;
  }
}
