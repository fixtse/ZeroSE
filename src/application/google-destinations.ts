import type { Config } from '../domain/config.js';
import type { BotId } from '../domain/access.js';
import { scopedConfig } from './access.js';
import { requiredGoogleScopes, type GoogleConnectionRepository } from './google-connection.js';
import type { GoogleDestinationKind } from './admin-catalog.js';

export const googleDestinationFields = {
  calendars: 'calendarId',
  'task-lists': 'taskListId',
  'document-folders': 'documentFolderId',
} as const;
export interface GoogleDestinationResolver {
  destination(
    kind: GoogleDestinationKind,
    id: string,
    signal: AbortSignal,
  ): Promise<{ id: string; name: string }>;
}
export class GoogleDestinations {
  constructor(
    private repository: GoogleConnectionRepository,
    private config: Config,
    private resolver: (config: Config) => GoogleDestinationResolver,
  ) {}
  async save(bot: BotId, chatId: string, kind: GoogleDestinationKind, id: string) {
    const profile = await this.repository.profile(bot, chatId);
    if (!profile) return { status: 404, error: 'Perfil no encontrado.' };
    const scoped = scopedConfig(this.config, profile);
    const capability =
      kind === 'calendars' ? 'calendar' : kind === 'task-lists' ? 'tasks' : 'documents';
    if (
      !profile.capabilities.includes(capability) ||
      (kind === 'task-lists' && scoped.homeAssistant.taskProvider === 'home_assistant')
    )
      return { status: 403, error: 'Esta herramienta no usa Google en este perfil.' };
    const selected = await this.resolver(scoped).destination(kind, id, AbortSignal.timeout(10000));
    const field = googleDestinationFields[kind];
    const google = profile.google || scoped.google;
    const replacement = {
      ...google,
      [field]: selected.id,
      destinationNames: { ...google.destinationNames, [field]: selected.name },
    };
    const saved = await this.repository.replaceGoogleConnection(
      bot,
      chatId,
      profile.google,
      replacement,
      requiredGoogleScopes(profile, this.config.homeAssistant.taskProvider),
      this.config.homeAssistant.taskProvider || 'google',
    );
    return saved
      ? { status: 200, selected }
      : { status: 409, error: 'La conexión ha cambiado. Recarga antes de seleccionar el destino.' };
  }
}
