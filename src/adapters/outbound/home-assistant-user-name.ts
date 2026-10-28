import type { Config } from '../../domain/config.js';
import { homeAssistantCommand } from './home-assistant-socket.js';

/** A paired user's own name is readable without permission to administer other users. */
export async function homeAssistantUserName(
  connection: Config['homeAssistant'],
  userId: string,
  command: typeof homeAssistantCommand = homeAssistantCommand,
) {
  if (!connection.url || !connection.token) return undefined;
  const signal = AbortSignal.timeout(5000);
  const current = await command(connection, { type: 'auth/current_user' }, signal);
  if (current?.id === userId && typeof current.name === 'string' && current.name.trim())
    return current.name.trim();
  // Legacy bindings may use an administrator token belonging to a different user.
  if (!current?.is_admin && !current?.is_owner) return undefined;
  const users = await command(connection, { type: 'config/auth/list' }, signal);
  if (!Array.isArray(users)) return undefined;
  const user = users.find((user) => user.id === userId);
  return typeof user?.name === 'string' && user.name.trim() ? user.name.trim() : undefined;
}
