import { replyText } from '../domain/language.js';
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
        ? replyText(
            (await this.profile(session))?.replyLanguage,
            'Usa /model para ver y seleccionar un modelo para la siguiente pregunta.',
            'Use /model to view and select a model for your next question.',
          )
        : undefined;
    const [settings, profile] = await Promise.all([this.settings.read(), this.profile(session)]);
    const language = profile?.replyLanguage;
    const allowed = settings.models.filter((m) => profile?.alternateModels?.includes(m.id));
    if (!match[1])
      return allowed.length
        ? replyText(
            language,
            'Modelos para la siguiente pregunta:\n',
            'Models for the next question:\n',
          ) +
            allowed.map((m, index) => `/model #${index + 1} — ${m.label}`).join('\n') +
            replyText(
              language,
              '\n/model default — cancelar selección',
              '\n/model default — cancel selection',
            )
        : replyText(
            language,
            'El administrador no ha habilitado modelos alternativos para este perfil.',
            'The administrator has not enabled alternative models for this profile.',
          );
    if (match[1] === 'default') {
      await this.settings.selectNext(session, null);
      return replyText(
        language,
        'La siguiente pregunta usará tu modelo predeterminado.',
        'Your next question will use your default model.',
      );
    }
    const selected = /^#([1-9]\d*)$/.exec(match[1]);
    const model = selected
      ? allowed[Number(selected[1]) - 1]
      : allowed.find((m) => m.id === match[1]);
    if (!model)
      return replyText(
        language,
        'Modelo no permitido. Usa /model para ver los modelos habilitados por el administrador.',
        'Model not permitted. Use /model to view models enabled by the administrator.',
      );
    await this.settings.selectNext(session, model.id);
    return replyText(
      language,
      `La siguiente pregunta usará ${model.label}. Después volverás a tu modelo predeterminado.`,
      `Your next question will use ${model.label}. Then you will return to your default model.`,
    );
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
    // Resolve application tools against the actual model, including one-turn overrides.
    context.aiModel = model.model;
    context.aiEffort = model.effort;
    if (provider.kind === 'codex') {
      return this.codex.run(...args);
    }
    return this.remote(provider, model).run(...args);
  }
}
