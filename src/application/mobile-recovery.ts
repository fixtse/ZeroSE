/** Resolve current person-owned Companion App destinations using the linked user's credentials. */
export interface MobileRecoveryPort {
  targets(profileChatId: string, userId: string): Promise<string[]>;
  send(profileChatId: string, userId: string, targets: string[], code: string): Promise<void>;
}
