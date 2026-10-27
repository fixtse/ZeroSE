import { and, eq, isNotNull } from 'drizzle-orm';
import { mobileRecovery } from '../outbound/auth-schema.js';
import { type Database } from '../outbound/database.js';
import { createHash } from 'node:crypto';
import type { MobileRecoveryPort } from '../../application/mobile-recovery.js';

/** Existing verified enrollments identify accounts; device lists are never persisted here. */
export class MobileRecoveryAdmin {
  constructor(
    private db: Database,
    private port: MobileRecoveryPort,
  ) {}
  async initialize() {}
  private async link(userId: string) {
    const [row] = await this.db
      .select()
      .from(mobileRecovery)
      .where(and(eq(mobileRecovery.user_id, userId), isNotNull(mobileRecovery.verified_at)));
    return row;
  }
  async configured(userId: string) {
    return !!(await this.link(userId));
  }
  private async resolve(userId: string) {
    const row = await this.link(userId);
    if (!row?.profile_chat_id || !row.ha_user_id) return undefined;
    const targets = await this.port.targets(row.profile_chat_id, row.ha_user_id);
    if (!targets.length) return undefined;
    const address =
      'mobile:' +
      userId +
      ':' +
      createHash('sha256')
        .update(JSON.stringify([row.profile_chat_id, row.ha_user_id, row.verified_at, targets]))
        .digest('hex');
    return { profileChatId: row.profile_chat_id, haUserId: row.ha_user_id, targets, address };
  }
  async recipient(userId: string) {
    try {
      return (await this.resolve(userId))?.address;
    } catch {
      return undefined;
    }
  }
  async send(address: string, code: string) {
    const resolved = await this.resolve(address.split(':')[1]);
    if (!resolved || resolved.address !== address) throw new Error('El destino ha cambiado.');
    await this.port.send(resolved.profileChatId, resolved.haUserId, resolved.targets, code);
  }
}
