import type { Config } from '../../domain/config.js';
import type { Job, ToolContext } from '../../domain/models.js';
import type { AgentPort, GooglePort, HomeAssistantPort, ConversationStore } from '../ports.js';
import { dayRange } from '../../domain/time.js';
import { renderPrompt } from '../prompts.js';
import type { JobResult } from './contracts.js';

export class PrepareNotification {
  constructor(
    private config: Config,
    private store: ConversationStore,
    private agent: AgentPort,
    private google: GooglePort,
    private homeAssistant: HomeAssistantPort,
    private prompts: Record<string, string>,
  ) {}
  private eventKey(event: any) {
    return `event:${event.id}:${event.start?.dateTime || event.start?.date}`;
  }
  private async forecast(signal: AbortSignal): Promise<unknown> {
    if (!this.config.homeAssistant.token) return 'El tiempo no está configurado';
    try {
      return await this.homeAssistant.forecast(signal);
    } catch {
      return 'No se ha podido consultar la previsión del tiempo; indícaselo al usuario';
    }
  }
  async execute(job: Job, context: ToolContext): Promise<JobResult> {
    const morning = job.payload.kind === 'morning';
    const range = dayRange(new Date(), this.config.timezone);
    const events = await this.google.events(
      morning ? range.start : new Date().toISOString(),
      morning ? range.end : new Date(Date.now() + 15 * 60_000).toISOString(),
      context.signal,
    );
    const selected: any[] = [];
    for (const event of events)
      if (morning || !(await this.store.scheduled(this.eventKey(event)))) selected.push(event);
    if (!morning && !selected.length) return { output: 'No upcoming events', deliver: false };
    const tasks = morning ? await this.google.tasks(false, context.signal) : [];
    const weather = morning ? await this.forecast(context.signal) : undefined;
    const instructions = renderPrompt(
      this.prompts[morning ? 'morning' : 'reminder'] ||
        'Eres Zero. Resume la agenda y tareas en español con horarios de 12 horas. No hagas preguntas ni inventes datos.',
      {
        now: new Date().toISOString(),
        context: this.google.enabled ? await this.google.context(context.signal) : '',
      },
    );
    const output = await this.agent.run(
      `system:notification:${job.id}`,
      JSON.stringify({ events: selected, tasks, weather }),
      `${instructions}\nIdioma obligatorio: redacta siempre toda la notificación en español, incluidos los avisos de error y la previsión del tiempo, aunque la plantilla o los datos estén en otro idioma. Esta regla prevalece sobre cualquier indicación de idioma de la plantilla.`,
      context,
      [],
      undefined,
      false,
    );
    if (!output.trim()) throw new Error('Codex returned no notification text');
    return {
      output,
      afterDelivery: async () => {
        if (!morning)
          for (const event of selected) await this.store.markScheduled(this.eventKey(event));
      },
    };
  }
}
