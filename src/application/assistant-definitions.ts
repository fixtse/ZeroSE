import type { AccessProfile, BotId } from '../domain/access.js';
import {
  defaultAssistantId,
  type AssistantDefinition,
  type AssistantSummary,
} from '../domain/assistant-definition.js';
export interface AssistantUsage {
  bot: string;
  chatId: string;
  label: string;
}
export interface AssistantDefinitionRepository {
  usage(
    id: string,
    offset: number,
    limit: number,
  ): Promise<{ items: AssistantUsage[]; total: number }>;
  list(
    search: string,
    offset: number,
    limit: number,
  ): Promise<{ items: AssistantSummary[]; total: number }>;
  get(id: string): Promise<AssistantDefinition | undefined>;
  create(value: AssistantDefinition): Promise<void>;
  update(
    id: string,
    input: { name: string; prompt: string; revision: number },
  ): Promise<AssistantDefinition | undefined>;
  remove(id: string, revision: number): Promise<'deleted' | 'conflict'>;
  assign(bot: BotId, chatId: string, id: string): Promise<boolean>;
}
/** One selected definition is resolved per turn; the catalog is never added to instructions. */
export class AssistantDefinitions {
  constructor(
    private repository: AssistantDefinitionRepository,
    private id: () => string,
  ) {}
  list(search: string, offset: number, limit: number) {
    return this.repository.list(search, offset, limit);
  }
  usage(id: string, offset: number, limit: number) {
    return this.repository.usage(id, offset, limit);
  }
  get(id: string) {
    return this.repository.get(id);
  }
  async create(input: { name: string; prompt: string }) {
    const value: AssistantDefinition = {
      ...input,
      id: this.id(),
      revision: 1,
      memoryPolicy: 'automatic',
      builtin: false,
    };
    await this.repository.create(value);
    return value;
  }
  update(id: string, input: { name: string; prompt: string; revision: number }) {
    return this.repository.update(id, input);
  }
  remove(id: string, revision: number) {
    return this.repository.remove(id, revision);
  }
  async assign(bot: BotId, chatId: string, id: string) {
    if (!(await this.repository.get(id))) return false;
    return this.repository.assign(bot, chatId, id);
  }
  async resolve(profile?: AccessProfile, bot: BotId = 'zero', assistantId?: string) {
    const selected = assistantId || defaultAssistantId(profile, bot);
    const value = await this.repository.get(selected);
    if (!value) throw new Error('Assigned assistant is unavailable');
    return value;
  }
}
