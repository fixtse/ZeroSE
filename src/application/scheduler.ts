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
  async tick(now = new Date()) {
    if (!this.config.schedules.enabled) return;
    const { day, time } = localClock(now, this.config.timezone);
    const enqueue = async (key: string, session: string, payload: any) => {
      if (await this.store.scheduled(key)) return;
      await this.store.enqueue(session, payload, key);
      await this.store.markScheduled(key);
    };
    if (time === this.config.schedules.reset) {
      const sessions = (await this.store.sessions()).filter((id) => !id.startsWith('system:'));
      for (const s of sessions)
        await enqueue(`reset:${day}:${s}`, String(s), {
          kind: 'reset',
          ...(String(s).startsWith('telegram:') ? { chatId: String(s).slice(9) } : {}),
        });
    }
    const chat = this.config.telegram.notificationChatId,
      session = 'telegram:' + chat;
    if (chat && time === this.config.schedules.morning)
      await enqueue('morning:' + day, session, { kind: 'morning', chatId: chat });
    if (time === this.config.schedules.consolidate)
      for (const s of await this.memory.pendingSessions())
        await enqueue(`memory:${day}:${s}`, s, { kind: 'consolidate' });
    if (chat && this.config.schedules.eventReminders && Number(time.slice(3)) % 15 === 0)
      await enqueue(`events:${day}:${time}`, session, { kind: 'event_reminders', chatId: chat });
  }
  start() {
    const tick = () =>
      void this.tick().catch(() => console.error(JSON.stringify({ event: 'scheduler_failed' })));
    tick();
    this.timer = setInterval(tick, 15_000);
  }
  close() {
    if (this.timer) clearInterval(this.timer);
  }
}
