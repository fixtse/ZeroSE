import type {
  Job,
  GeneratedImage,
  ToolContext,
  MemoryFragment,
  MemoryMatch,
  MemorySearchResult,
  PendingMemoryMessage,
} from '../domain/models.js';

export interface ConversationStore {
  cursor(name: string): Promise<number>;
  setCursor(name: string, value: number): Promise<void>;
  enqueue(session: string, payload: unknown, dedupe?: string): Promise<Job>;
  job(id: string): Promise<Job | undefined>;
  claim(excluded: string[]): Promise<Job | undefined>;
  finish(id: string, output: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  thread(session: string): Promise<string | undefined>;
  threadPolicy(session: string): Promise<string | undefined>;
  setThread(session: string, thread: string, policy?: string): Promise<void>;
  reset(session?: string): Promise<void>;
  addMessage(session: string, role: string, text: string): Promise<void>;
  history(session: string): Promise<unknown[]>;
  sessions(): Promise<string[]>;
  scheduled(key: string): Promise<boolean>;
  markScheduled(key: string): Promise<void>;
}
export interface AuditPort {
  audit(job: string, tool: string, success: boolean, duration: number): Promise<void>;
}
export interface MemoryRepository {
  insertMemory(
    session: string,
    value: MemoryFragment,
    embedding: number[] | null,
    source?: string,
  ): Promise<void>;
  searchMemory(
    session: string,
    query: string,
    vector: number[] | undefined,
    categories: string[],
    start?: string,
    end?: string,
  ): Promise<MemoryMatch[]>;
  readMemory(session: string, id: string): Promise<MemoryMatch | undefined>;
  memoryCatalog(session: string): Promise<{ categories: string[]; tags: string[] }>;
  pendingMemoryMessages(session: string): Promise<PendingMemoryMessage[]>;
  pendingMemorySessions(): Promise<string[]>;
  markConsolidated(session: string, ids: number[]): Promise<void>;
}
export interface EmbeddingsPort {
  readonly enabled: boolean;
  embed(text: string, taskType: string, signal?: AbortSignal): Promise<number[]>;
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
  ): Promise<MemorySearchResult[]>;
  read(session: string, id: string, offset?: number): Promise<unknown>;
  catalog(session: string): Promise<{ categories: string[]; tags: string[] }>;
  pending(session: string): Promise<PendingMemoryMessage[]>;
  pendingSessions(): Promise<string[]>;
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
  location(signal?: AbortSignal): Promise<unknown>;
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
  ): Promise<{ text: string; images: string[]; transcriptionOnly: boolean; serviceReply?: string }>;
  send(chat: string, text: string, signal?: AbortSignal, replyTo?: number): Promise<void>;
  sendImage(
    chat: string,
    image: GeneratedImage,
    signal: AbortSignal,
    replyTo?: number,
  ): Promise<void>;
  sendVoice(chat: string, text: string, job: string, signal: AbortSignal): Promise<void>;
  typing(chat: string, signal?: AbortSignal): Promise<unknown>;
}
