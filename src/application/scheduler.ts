import type { ConversationStore } from './ports.js';
import type { ProfileNotifications } from '../domain/access.js';
import { sessionAddress } from '../domain/access.js';
import { morningKey } from './profile-notifications.js';
import { localClock } from '../domain/time.js';

export interface ScheduleProfile {
  timezone: string;
  enabled: boolean;
  notifications: ProfileNotifications;
  calendar: boolean;
}
export class Scheduler {
  private timer?: NodeJS.Timeout;
  constructor(
    private store: ConversationStore,
    private profile: (session: string) => Promise<ScheduleProfile>,
    private recipients?: () => Promise<string[]>,
  ) {}
  async tick(now = new Date()) {
    const enqueue = async (key: string, session: string, payload: any) => {
      if (await this.store.scheduled(key)) return;
      await this.store.enqueue(session, payload, key);
      await this.store.markScheduled(key);
    };
    const existing = new Set(
      (await this.store.sessions()).filter((id) => !id.startsWith('system:')),
    );
    const sessions = new Set([...existing, ...((await this.recipients?.()) || [])]);
    for (const session of sessions) {
      const profile = await this.profile(session);
      if (!profile.enabled) continue;
      const { day, time } = localClock(now, profile.timezone);
      if (
        profile.notifications.reset.enabled &&
        existing.has(session) &&
        time === profile.notifications.reset.time
      )
        await enqueue(`reset:${day}:${session}`, session, {
          kind: 'reset',
          ...(session.startsWith('telegram:') ? { chatId: session.slice(9) } : {}),
        });
      const personal = profile.notifications;
      const target = sessionAddress(session);
      if (target?.chatId.startsWith('ha:')) continue;
      if (!target) continue;
      if (personal.morning.mode === 'time' && time === personal.morning.time)
        await enqueue(morningKey(session, day), session, {
          kind: 'morning',
          chatId: target.chatId,
        });
      if (personal.eventReminders && profile.calendar)
        await enqueue(`events:${now.toISOString().slice(0, 16)}:${session}`, session, {
          kind: 'event_reminders',
          chatId: target.chatId,
        });
    }
  }
  start() {
    let lastMinute: number | undefined;
    const tick = () => {
      const now = new Date();
      const minute = Math.floor(now.getTime() / 60_000);
      if (minute === lastMinute) return;
      lastMinute = minute;
      void this.tick(now).catch(() => console.error(JSON.stringify({ event: 'scheduler_failed' })));
    };
    tick();
    this.timer = setInterval(tick, 15_000);
  }
  close() {
    if (this.timer) clearInterval(this.timer);
  }
}
