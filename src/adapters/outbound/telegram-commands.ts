import type { ChatCommandsControl } from '../../application/access.js';
import type { AccessProfile, BotId } from '../../domain/access.js';

interface TelegramApi {
  call(method: string, body: unknown, signal?: AbortSignal): Promise<any>;
}

/** Publish only implemented slash commands, scoped to the approved chat. */
export class TelegramCommands implements ChatCommandsControl {
  constructor(private telegram: (bot: BotId) => Promise<TelegramApi>) {}

  async configure(profile: AccessProfile) {
    const commands = profile.enabled
      ? [
          { command: 'nuevo', description: 'Iniciar una conversación nueva sin borrar recuerdos' },
          ...(profile.capabilities.includes('tasks')
            ? [{ command: 'clean', description: 'Vaciar la lista de tareas configurada' }]
            : []),
        ]
      : [];
    const result = await (
      await this.telegram(profile.bot)
    ).call(
      'setMyCommands',
      { commands, scope: { type: 'chat', chat_id: profile.chatId }, language_code: '' },
      AbortSignal.timeout(15_000),
    );
    if (result !== true) throw new Error('Telegram did not confirm chat command registration');
  }
}
