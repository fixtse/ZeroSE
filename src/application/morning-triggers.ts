import type { Config } from '../domain/config.js';
import type { AccessProfile, ProfileNotifications } from '../domain/access.js';
import { telegramSession } from '../domain/access.js';
import { localClock } from '../domain/time.js';
import type { ConversationStore } from './ports.js';
import type { AccessRepository } from './access.js';
import { profileNotifications, morningKey } from './profile-notifications.js';

export interface MorningTriggerPort {
  watch(
    key: string,
    config: Config['homeAssistant'],
    trigger: ProfileNotifications['morning'],
    wake: () => Promise<void>,
  ): void;
  retain(keys: Set<string>): void;
  close(): void;
  discover(
    config: Config['homeAssistant'],
    automationId: string,
  ): Promise<{ entity: string; state: string } | undefined>;
}

export async function importMorningTrigger(
  profile: AccessProfile,
  config: Config,
  repository: AccessRepository,
  triggers: MorningTriggerPort,
) {
  if (!profile.morningImportAutomation) return;
  const trigger = await triggers.discover(config.homeAssistant, profile.morningImportAutomation);
  if (!trigger) return;
  profile.notifications = {
    ...profileNotifications(profile),
    morning: { ...profileNotifications(profile).morning, mode: 'entity', ...trigger },
  };
  profile.morningCallbackTrigger = trigger;
  profile.morningImportAutomation = undefined;
  await repository.saveProfile(profile);
}

export class MorningTriggers {
  constructor(
    private triggers: MorningTriggerPort,
    private store: ConversationStore,
  ) {}
  refresh(profiles: { profile: AccessProfile; config: Config }[]) {
    const keys = new Set<string>();
    for (const { profile, config } of profiles) {
      const morning = profileNotifications(profile).morning;
      if (
        profile.morningImportAutomation ||
        !profile.enabled ||
        profile.chatId.startsWith('ha:') ||
        morning.mode !== 'entity' ||
        !profile.capabilities.includes('homeAssistant') ||
        !config.homeAssistant.token
      )
        continue;
      const session = telegramSession(profile.bot, profile.chatId);
      keys.add(session);
      this.triggers.watch(session, config.homeAssistant, morning, async () => {
        const { day } = localClock(new Date(), profile.timezone || config.timezone);
        const key = morningKey(session, day);
        if (await this.store.scheduled(key)) return;
        await this.store.enqueue(
          session,
          {
            kind: 'morning',
            chatId: profile.chatId,
            wakeUp: true,
            morningTrigger: { entity: morning.entity, state: morning.state },
          },
          key,
        );
        await this.store.markScheduled(key);
      });
    }
    this.triggers.retain(keys);
  }
  close() {
    this.triggers.close();
  }
}
