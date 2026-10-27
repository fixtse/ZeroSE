import type { AISettingsPort, AIProvider, AIModel } from '../domain/ai.js';
import type { AccessProfile } from '../domain/access.js';
import type { AgentPort } from './ports.js';

/** Selection is enforced by the application, never by model instructions. */
export class AIAgent implements AgentPort {
  constructor(
    private settings: AISettingsPort,
    private profile: (session: string) => Promise<AccessProfile | undefined>,
    private codex: AgentPort,
    private remote: (provider: AIProvider, model: AIModel) => AgentPort,
  ) {}
  async userCommand(session: string, text: string) {
    const match = /^\/model(?:@[a-z\d_]+)?(?:\s+(\S+))?\s*$/i.exec(text.trim());
    if (!match)
      return /^\/model(?:@[a-z\d_]+)?(?:\s|$)/i.test(text.trim())
        ? 'Usa /model para ver y seleccionar un modelo para la siguiente pregunta.'
        : undefined;
    const [settings, profile] = await Promise.all([this.settings.read(), this.profile(session)]);
    const allowed = settings.models.filter((m) => profile?.alternateModels?.includes(m.id));
    if (!match[1])
      return allowed.length
        ? 'Modelos para la siguiente pregunta:\n' +
            allowed.map((m, index) => `/model #${index + 1} — ${m.label}`).join('\n') +
            '\n/model default — cancelar selección'
        : 'El administrador no ha habilitado modelos alternativos para este perfil.';
    if (match[1] === 'default') {
      await this.settings.selectNext(session, null);
      return 'La siguiente pregunta usará tu modelo predeterminado.';
    }
    const selected = /^#([1-9]\d*)$/.exec(match[1]);
    const model = selected
      ? allowed[Number(selected[1]) - 1]
      : allowed.find((m) => m.id === match[1]);
    if (!model)
      return 'Modelo no permitido. Usa /model para ver los modelos habilitados por el administrador.';
    await this.settings.selectNext(session, model.id);
    return `La siguiente pregunta usará ${model.label}. Después volverás a tu modelo predeterminado.`;
  }
  async run(...args: Parameters<AgentPort['run']>) {
    const [session, , , context] = args;
    context.signal.throwIfAborted();
    const [settings, profile] = await Promise.all([
      this.settings.read(),
      this.profile(context.session),
    ]);
    const next = context.userQuestion ? await this.settings.consumeNext(session) : undefined;
    if (next && !profile?.alternateModels?.includes(next))
      throw new Error(
        'The selected model is no longer permitted. Select an approved model before asking again.',
      );
    const id = next || profile?.defaultModel || settings.defaultModel;
    const model = settings.models.find((m) => m.id === id);
    const provider = settings.providers.find((p) => p.id === model?.provider);
    if (!model || !provider)
      throw new Error(
        'The configured AI model is unavailable. Ask the administrator to select a model.',
      );
    if (provider.kind === 'codex') {
      context.aiModel = model.model;
      context.aiEffort = model.effort;
      return this.codex.run(...args);
    }
    return this.remote(provider, model).run(...args);
  }
}
