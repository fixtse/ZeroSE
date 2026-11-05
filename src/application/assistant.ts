import { membershipEvent } from '../domain/access.js';
import type { Config } from '../domain/config.js';
import type { GeneratedImage, Job, ToolContext } from '../domain/models.js';
import type { ConversationStore, MediaPort, TelegramPort } from './ports.js';
import type { JobHandlers, JobResult } from './use-cases/contracts.js';

/** Executes durable jobs. Domain work lives in the injected use cases. */
export class Assistant {
  private active = new Map<string, Promise<void>>();
  private controllers = new Set<AbortController>();
  private timer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  private stopping = false;
  constructor(
    private config: Config,
    private store: ConversationStore,
    private handlers: JobHandlers,
    private media: MediaPort,
    private telegram: TelegramPort,
    private telegramForJob?: (job: Job) => Promise<TelegramPort>,
    private canRespond: (job: Job, result?: JobResult) => Promise<boolean> = async () => true,
    private voiceRepliesEnabled: (job: Job) => Promise<boolean> = async () => true,
  ) {}
  start() {
    const pump = () => {
      if (this.stopping || this.pumping) return;
      this.pumping = this.pump()
        .catch(() => {
          console.error(JSON.stringify({ event: 'job_claim_failed' }));
        })
        .finally(() => {
          this.pumping = undefined;
        });
    };
    this.timer = setInterval(pump, 250);
    pump();
  }
  private async pump() {
    while (!this.stopping && this.active.size < this.config.concurrency) {
      const job = await this.store.claim([...this.active.keys()]);
      if (!job) break;
      const work = this.execute(job)
        .catch(() => {
          console.error(JSON.stringify({ event: 'job_state_failed', job: job.id }));
        })
        .finally(() => this.active.delete(job.session));
      this.active.set(job.session, work);
    }
  }
  private chat(job: Job): string | undefined {
    return (
      job.payload.chatId ||
      (job.payload.kind === 'telegram' ? String(job.payload.message.chat.id) : undefined)
    );
  }
  private async deliver(
    job: Job,
    result: JobResult,
    signal: AbortSignal,
    telegram: TelegramPort,
    images: GeneratedImage[] = [],
  ) {
    const chat = this.chat(job);
    if (!chat || result.deliver === false) return;
    if (!(await this.canRespond(job, result)) && !membershipEvent(job.payload.message)) return;
    for (const image of images) {
      if (!(await this.canRespond(job, result))) return;
      await telegram.sendImage(chat, image, signal, job.payload.message?.message_id);
    }
    if (result.output.trim())
      await telegram.send(
        chat,
        result.output,
        signal,
        job.payload.message?.message_id,
        result.choices,
      );
    await result.afterDelivery?.();
    if (
      !result.output.trim() ||
      !this.config.telegram.voiceReplies ||
      result.voice === false ||
      result.output.length > 4000 ||
      !(await this.canRespond(job, result)) ||
      !(await this.voiceRepliesEnabled(job))
    )
      return;
    try {
      await telegram.sendVoice(chat, result.output, job.id, signal);
    } catch {
      console.error(JSON.stringify({ event: 'voice_reply_failed', job: job.id }));
      await telegram.send(
        chat,
        'No se pudo generar la respuesta de voz; la respuesta de texto está arriba.',
        signal,
      );
    }
  }
  private typing(
    job: Job,
    signal: AbortSignal,
    telegram: TelegramPort,
  ): NodeJS.Timeout | undefined {
    const chat = this.chat(job);
    if (!chat || job.payload.kind !== 'telegram') return;
    const send = () => {
      void this.canRespond(job)
        .then((permitted) => (permitted ? telegram.typing(chat, signal) : undefined))
        .catch(() => {});
    };
    send();
    return setInterval(send, 4000);
  }
  private async execute(job: Job) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const deadline = setTimeout(() => controller.abort(), this.config.codex.timeoutMs);
    const context: ToolContext = {
      session: job.session,
      jobId: job.id,
      signal: controller.signal,
      ...(job.payload.source === 'home_assistant_voice'
        ? { source: 'home_assistant_voice' as const }
        : {}),
    };
    let typing: NodeJS.Timeout | undefined;
    let telegram: TelegramPort | undefined;
    try {
      telegram = this.telegramForJob ? await this.telegramForJob(job) : this.telegram;
      if (await this.canRespond(job)) typing = this.typing(job, context.signal, telegram);
      const handler = this.handlers[job.payload.kind];
      if (!handler) throw new Error('Unsupported assistant job');
      const result = await handler(job, context);
      await this.deliver(job, result, context.signal, telegram, context.generatedImages);
      await this.store.finish(job.id, result.output);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Assistant failed';
      await this.store.fail(job.id, message);
      console.error(JSON.stringify({ event: 'job_failed', job: job.id, kind: job.payload.kind }));
      const chat = this.chat(job);
      if (chat && telegram && (await this.canRespond(job)))
        await telegram
          .send(
            chat,
            `No pude completar la solicitud: ${message}. Si hubo una acción, comprueba su resultado antes de repetirla.`,
            AbortSignal.timeout(10_000),
          )
          .catch(() => {});
    } finally {
      clearTimeout(deadline);
      if (typing) clearInterval(typing);
      this.controllers.delete(controller);
      await this.media.cleanup(job.id).catch(() => {});
    }
  }
  async close() {
    this.stopping = true;
    await this.pumping;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.active.values());
  }
}
