import type { AccessRepository } from './access.js';
import { sessionAddress } from '../domain/access.js';

export const contextLimit = 16000;
export interface ContextRepository extends Pick<AccessRepository, 'profile'> {
  updateContext(
    bot: string,
    chatId: string,
    text: string,
    revision: number,
    requireEnabled?: boolean,
  ): Promise<number | undefined>;
}
/** Compare-and-swap prevents UI and agent edits from silently overwriting each other. */
export class UserContext {
  constructor(private profiles: ContextRepository) {}
  async read(session: string) {
    const address = sessionAddress(session);
    const profile = address ? await this.profiles.profile(address.bot, address.chatId) : undefined;
    if (!profile?.enabled || profile.memoryMode === 'none')
      throw new Error('Memory is disabled or profile unavailable');
    return { context: profile.context || '', revision: profile.contextRevision || 0 };
  }
  async save(
    session: string,
    memory: string,
    mode: 'append' | 'replace',
    revision: number,
    requireEnabled = true,
  ) {
    const address = sessionAddress(session);
    if (!address) throw new Error('User context requires a user or group profile');
    const profile = await this.profiles.profile(address.bot, address.chatId);
    if (!profile || (requireEnabled && !profile.enabled) || profile.memoryMode === 'none')
      throw new Error('Memory is disabled or profile unavailable');
    if ((profile.contextRevision || 0) !== revision)
      throw new Error('Context changed; reload before editing');
    const value =
      mode === 'replace' ? memory : [profile.context, memory].filter(Boolean).join('\n');
    if (value.length > contextLimit) throw new Error(`Context exceeds ${contextLimit} characters`);
    const saved = await this.profiles.updateContext(
      address.bot,
      address.chatId,
      value,
      revision,
      requireEnabled,
    );
    if (saved === undefined)
      throw new Error('Context changed or memory disabled; reload before editing');
    return { saved: true, revision: saved };
  }
}
