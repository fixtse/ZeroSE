import type { GroupMember } from '../domain/group-member.js';

export interface GroupMembersRepository {
  list(
    bot: string,
    chatId: string,
    search: string,
    offset: number,
    limit: number,
  ): Promise<{ items: GroupMember[]; total: number }>;
  get(bot: string, chatId: string, userId: string): Promise<GroupMember | undefined>;
  save(bot: string, chatId: string, member: GroupMember, createOnly?: boolean): Promise<boolean>;
  observe(
    bot: string,
    chatId: string,
    member: Pick<GroupMember, 'userId' | 'name' | 'username' | 'present'>,
  ): Promise<void>;
  remove(bot: string, chatId: string, userId: string): Promise<void>;
  migrate(bot: string, from: string, to: string): Promise<void>;
}

export class GroupMembers {
  constructor(readonly repository: GroupMembersRepository) {}
  async locationEntities(bot: string, chatId: string, userId: string) {
    const member = await this.repository.get(bot, chatId, userId);
    if (!member?.present || !(member.locationEntity || member.geocodedLocationEntity))
      throw new Error(
        'This member has no active location assignment in this group. Configure it in Integrantes.',
      );
    return {
      locationEntity: member.locationEntity,
      geocodedLocationEntity: member.geocodedLocationEntity,
    };
  }
  async observe(bot: string, chatId: string, message: any) {
    const people = [
      message.sender_chat ? undefined : message.from,
      ...(message.new_chat_members || []),
    ];
    for (const user of people) await this.person(bot, chatId, user, true);
    await this.person(bot, chatId, message.left_chat_member, false);
  }
  private async person(bot: string, chatId: string, user: any, present: boolean) {
    if (!user || user.is_bot || !Number.isSafeInteger(user.id) || user.id <= 0) return;
    await this.repository.observe(bot, chatId, {
      userId: String(user.id),
      name:
        [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 100) ||
        String(user.id),
      username: String(user.username || '').slice(0, 64),
      present,
    });
  }
}
