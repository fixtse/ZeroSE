import type { Config } from '../domain/config.js';
import type { ConversationStore } from './ports.js';
import { localClock } from '../domain/time.js';

export interface ScheduleProfile {
  timezone: string;
  enabled: boolean;
}
export class Scheduler {
  private timer?: NodeJS.Timeout;
  constructor(
    private config: Config,
    private store: ConversationStore,
    private profile?: (session: string) => Promise<ScheduleProfile>,
  ) {}
  async tick(now = new Date()) {
    if (!this.config.schedules.enabled) return;
    const enqueue = async (key: string, session: string, payload: any) => {
      if (await this.store.scheduled(key)) return;
      await this.store.enqueue(session, payload, key);
      await this.store.markScheduled(key);
    };
    const existing = new Set(
      (await this.store.sessions()).filter((id) => !id.startsWith('system:')),
    );
    const chat = this.config.telegram.notificationChatId;
    const notificationSession = 'telegram:' + chat;
    const sessions = new Set([...existing, ...(chat ? [notificationSession] : [])]);
    for (const session of sessions) {
      const profile = this.profile
        ? await this.profile(session)
        : {
            enabled: true,
            timezone: this.config.timezone,
          };
      if (!profile.enabled) continue;
      const { day, time } = localClock(now, profile.timezone);
      if (existing.has(session) && time === this.config.schedules.reset)
        await enqueue(`reset:${day}:${session}`, session, {
          kind: 'reset',
          ...(session.startsWith('telegram:') ? { chatId: session.slice(9) } : {}),
        });
      if (session !== notificationSession || !chat) continue;
      if (time === this.config.schedules.morning)
        await enqueue('morning:' + day, session, { kind: 'morning', chatId: chat });
      if (this.config.schedules.eventReminders && Number(time.slice(3)) % 15 === 0)
        await enqueue(`events:${day}:${time}`, session, { kind: 'event_reminders', chatId: chat });
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
