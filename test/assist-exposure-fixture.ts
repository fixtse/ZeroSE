import type { homeAssistantCommand } from '../src/adapters/outbound/home-assistant-socket.js';

/** Test-only HA exposure responder; independent of profile configuration and assignments. */
export function assistExposureFixture(
  exposed?: string[] | (() => string[]),
): typeof homeAssistantCommand {
  return async (_config, command) => {
    if (command.type !== 'assistant_zero/assist/check')
      throw new Error('Unexpected exposure command');
    const allowed = typeof exposed === 'function' ? exposed() : exposed;
    return (command.entity_ids as string[]).filter((id) => !allowed || allowed.includes(id));
  };
}
