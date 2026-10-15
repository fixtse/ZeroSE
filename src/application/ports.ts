import type { Config } from '../domain/config.js';
import type {
  Job,
  ToolContext,
  MemoryFragment,
  StoredMemory,
  MemoryMatch,
  PendingMemoryMessage,
} from '../domain/models.js';

export interface ConversationStore {
  enqueue(session: string, payload: unknown, dedupe?: string): Job;
  job(id: string): Job | undefined;
  claim(excluded: string[]): Job | undefined;
  finish(id: string, output: string): void;
  fail(id: string, error: string): void;
  thread(session: string): string | undefined;
  setThread(session: string, thread: string): void;
  reset(session?: string): void;
  addMessage(session: string, role: string, text: string): void;
  history(session: string): unknown[];
  sessions(): string[];
  scheduled(key: string): boolean;
  markScheduled(key: string): void;
}
export interface AuditPort {
  audit(job: string, tool: string, success: boolean, duration: number): void;
}
export interface MemoryRepository {
  insertMemory(
    session: string,
    value: MemoryFragment,
    embedding: number[] | null,
    source?: string,
  ): void;
  memories(session: string): StoredMemory[];
  pendingMemoryMessages(session: string): PendingMemoryMessage[];
  pendingMemorySessions(): string[];
  markConsolidated(session: string, ids: number[]): void;
}
export interface EmbeddingsPort {
  readonly enabled: boolean;
  embed(text: string, taskType: string, signal?: AbortSignal): Promise<number[]>;
}
export interface LegacyMemoryPort {
  search(
    vector: number[],
    categories: string[],
    start?: string,
    end?: string,
    signal?: AbortSignal,
  ): Promise<MemoryMatch[]>;
  close(): Promise<void>;
}
export interface MemoryPort {
  save(
    session: string,
    value: MemoryFragment,
    source?: string,
    signal?: AbortSignal,
  ): Promise<{ saved: boolean }>;
  search(
    session: string,
    query: string,
    categories?: string[],
    start?: string,
    end?: string,
    signal?: AbortSignal,
  ): Promise<MemoryMatch[]>;
  catalog(session: string): { categories: string[]; tags: string[] };
  pending(session: string): PendingMemoryMessage[];
  pendingSessions(): string[];
  consolidate(
    session: string,
    fragments: MemoryFragment[],
    ids: number[],
    signal?: AbortSignal,
  ): Promise<void>;
}
export interface AgentPort {
  run(
    session: string,
    prompt: string,
    instructions: string,
    context: ToolContext,
    images?: string[],
    schema?: unknown,
    toolsEnabled?: boolean,
  ): Promise<string>;
}
export interface GooglePort {
  readonly enabled: boolean;
  context(signal?: AbortSignal): Promise<string>;
  cleanTasks(signal?: AbortSignal): Promise<{ deleted: number }>;
  events(start: string, end: string, signal?: AbortSignal): Promise<any[]>;
  tasks(includeCompleted?: boolean, signal?: AbortSignal): Promise<any[]>;
}
export interface HomeAssistantPort {
  forecast(signal?: AbortSignal): Promise<unknown>;
}
export interface HomeAssistantToolsPort extends HomeAssistantPort {
  sensors(search?: string, signal?: AbortSignal): Promise<unknown>;
  sensor(entity: string, signal?: AbortSignal): Promise<unknown>;
  history(entity: string, start: string, end: string, signal?: AbortSignal): Promise<unknown>;
  shopping(signal?: AbortSignal): Promise<unknown>;
  changeShopping(
    operation: 'add' | 'complete' | 'uncomplete' | 'remove',
    item: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export interface GoogleToolsPort extends GooglePort {
  availability(start: string, end: string, signal?: AbortSignal): Promise<unknown>;
  event(id: string, signal?: AbortSignal): Promise<unknown>;
  createEvent(value: unknown, signal?: AbortSignal): Promise<unknown>;
  updateEvent(id: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  deleteEvent(id: string, signal?: AbortSignal): Promise<unknown>;
  task(id: string, signal?: AbortSignal): Promise<unknown>;
  createTask(value: unknown, signal?: AbortSignal): Promise<unknown>;
  updateTask(id: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  deleteTask(id: string, signal?: AbortSignal): Promise<unknown>;
  saveContext(memory: string, signal?: AbortSignal): Promise<unknown>;
  createDocument(title: string, markdown: string, signal?: AbortSignal): Promise<unknown>;
}
export interface MediaPort {
  cleanup(job: string): Promise<void>;
}
export interface TelegramPort {
  input(
    message: any,
    job: string,
    signal: AbortSignal,
  ): Promise<{ text: string; images: string[]; transcriptionOnly: boolean }>;
  send(chat: string, text: string, signal?: AbortSignal, replyTo?: number): Promise<void>;
  sendVoice(chat: string, text: string, job: string, signal: AbortSignal): Promise<void>;
  typing(chat: string, signal?: AbortSignal): Promise<unknown>;
}
export type RuntimeConfig = Config;
