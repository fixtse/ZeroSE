import type { MobileRecoveryPort } from '../../application/mobile-recovery.js';
import type { Config } from '../../domain/config.js';
import { homeAssistantCommand } from './home-assistant-socket.js';

/** Uses an explicitly linked user's token, never Supervisor or another profile's credentials. */
export class HomeAssistantMobileRecovery implements MobileRecoveryPort {
  constructor(
    private connection: (
      chat: string,
    ) => Promise<{ userId: string; config: Config['homeAssistant'] } | undefined>,
    private command: typeof homeAssistantCommand = homeAssistantCommand,
  ) {}
  private async verified(chat: string, expectedUserId: string) {
    const connection = await this.connection(chat);
    if (!connection || connection.userId !== expectedUserId)
      throw new Error('La vinculación personal de Home Assistant ya no está disponible.');
    const user = await this.command(
      connection.config,
      { type: 'auth/current_user' },
      AbortSignal.timeout(10000),
    );
    if (user?.id !== expectedUserId) throw new Error('La identidad de Home Assistant ha cambiado.');
    return connection.config;
  }
  async targets(chat: string, userId: string) {
    const config = await this.verified(chat, userId);
    const result = await this.command(
      config,
      { type: 'assistant_zero/recovery/targets', user_id: userId },
      AbortSignal.timeout(10000),
    );
    if (
      !Array.isArray(result) ||
      result.length > 100 ||
      !result.every((value) => typeof value === 'string' && /^mobile_app_[a-z0-9_]+$/.test(value))
    )
      throw new Error('Home Assistant devolvió destinos de recuperación no válidos.');
    return [...new Set<string>(result)].sort();
  }
  async send(chat: string, userId: string, targets: string[], code: string) {
    const config = await this.verified(chat, userId);
    await this.command(
      config,
      { type: 'assistant_zero/recovery/send', user_id: userId, targets, code },
      AbortSignal.timeout(10000),
    );
  }
}
