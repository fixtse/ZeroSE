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
    private selectModel: (session: string, model: string | null) => Promise<boolean>,
  ) {}
  async userCommand(session: string, text: string) {
    const match = /^\/model(?:@[a-z\d_]+)?(?:\s+(.+?))?\s*$/i.exec(text.trim());
    if (!match)
      return /^\/model(?:@[a-z\d_]+)?(?:\s|$)/i.test(text.trim())
        ? replyText(
            (await this.profile(session))?.replyLanguage,
            'Usa /model para ver y seleccionar un modelo para tu perfil.',
            'Use /model to view and select a model for your profile.',
          )
        : undefined;
    const [settings, profile] = await Promise.all([this.settings.read(), this.profile(session)]);
    const language = profile?.replyLanguage;
    const allowed = settings.models.filter((m) => profile?.alternateModels?.includes(m.id));
    const commandFor = (model: AIModel) => {
      const name = model.label.trim().toLowerCase();
      return name &&
        name !== 'default' &&
        !/^#[1-9]\d*$/.test(name) &&
        allowed.filter((m) => m.label.trim().toLowerCase() === name).length === 1 &&
        !allowed.some((m) => m.id.toLowerCase() === name && m.id !== model.id)
        ? name
        : model.id;
    };
    if (!match[1]) {
      if (!allowed.length)
        return replyText(
          language,
          'El administrador no ha habilitado modelos alternativos para este perfil.',
          'The administrator has not enabled alternative models for this profile.',
        );
      const choices = allowed.map((m) => `/model ${commandFor(m)}`);
      choices.push('/model default');
      return {
        text:
          replyText(
            language,
            'Toca un modelo para tu perfil:\n',
            'Tap a model for your profile:\n',
          ) +
          allowed.map((m, index) => `${choices[index]} — ${m.label}`).join('\n') +
          replyText(
            language,
            '\n/model default — usar modelo global',
            '\n/model default — use global default',
          ),
        choices,
      };
    }
    if (match[1].toLowerCase() === 'default' && profile?.enabled) {
      if (!(await this.selectModel(session, null)))
        throw new Error('The profile model could not be updated.');
      return replyText(
        language,
        'Tu perfil usará el modelo predeterminado global hasta que elijas otro.',
        'Your profile will use the global default model until you choose another.',
      );
    }
    const selected = /^#([1-9]\d*)$/.exec(match[1]);
    const model = selected
      ? allowed[Number(selected[1]) - 1]
      : allowed.find((m) => m.id === match[1]) ||
        (() => {
          const matches = allowed.filter((m) => commandFor(m) === match[1].toLowerCase());
          return matches.length === 1 ? matches[0] : undefined;
        })();
    if (!model || !profile?.enabled)
      return replyText(
        language,
        'Modelo no permitido. Usa /model para ver los modelos habilitados por el administrador.',
        'Model not permitted. Use /model to view models enabled by the administrator.',
      );
    if (!(await this.selectModel(session, model.id)))
      throw new Error(
        'The model is no longer permitted or the profile is unavailable. Use /model to select again.',
      );
    return replyText(
      language,
      `Tu perfil usará ${model.label} hasta que elijas otro modelo.`,
      `Your profile will use ${model.label} until you choose another model.`,
    );
  }
  async run(...args: Parameters<AgentPort['run']>) {
    const context = args[3];
    context.signal.throwIfAborted();
    const [settings, profile] = await Promise.all([
      this.settings.read(),
      this.profile(context.session),
    ]);
    const id = profile?.defaultModel || settings.defaultModel;
    const model = settings.models.find((m) => m.id === id);
    const provider = settings.providers.find((p) => p.id === model?.provider);
    if (!model || !provider)
      throw new Error(
        'The configured AI model is unavailable. Ask the administrator to select a model.',
      );
    // Resolve application tools against the actual model, including the saved profile selection.
    context.aiModel = model.model;
    context.aiEffort = model.effort;
    if (provider.kind === 'codex') {
      return this.codex.run(...args);
    }
    return this.remote(provider, model).run(...args);
  }
}
