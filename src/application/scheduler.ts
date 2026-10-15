import type { Config } from '../domain/config.js';
import type { ConversationStore, MemoryPort } from './ports.js';
import { localClock } from '../domain/time.js';
export class Scheduler {
  private timer?: NodeJS.Timeout;
  constructor(
    private config: Config,
    private store: ConversationStore,
    private memory: MemoryPort,
  ) {}
  tick(now = new Date()) {
    if (!this.config.schedules.enabled) return;
    const { day, time } = localClock(now, this.config.timezone);
    const enqueue = (key: string, session: string, payload: any) => {
      if (this.store.scheduled(key)) return;
      this.store.enqueue(session, payload, key);
      this.store.markScheduled(key);
    };
    if (time === this.config.schedules.reset) {
      const sessions = this.store.sessions().filter((id) => !id.startsWith('system:'));
      for (const s of sessions)
        enqueue(`reset:${day}:${s}`, String(s), {
          kind: 'reset',
          ...(String(s).startsWith('telegram:') ? { chatId: String(s).slice(9) } : {}),
        });
    }
    const chat = this.config.telegram.notificationChatId,
      session = 'telegram:' + chat;
    if (chat && time === this.config.schedules.morning)
      enqueue('morning:' + day, session, { kind: 'morning', chatId: chat });
    if (time === this.config.schedules.consolidate)
      for (const s of this.memory.pendingSessions())
        enqueue(`memory:${day}:${s}`, s, { kind: 'consolidate' });
    if (chat && this.config.schedules.eventReminders && Number(time.slice(3)) % 15 === 0)
      enqueue(`events:${day}:${time}`, session, { kind: 'event_reminders', chatId: chat });
  }
  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15_000);
  }
  close() {
    if (this.timer) clearInterval(this.timer);
  }
}
