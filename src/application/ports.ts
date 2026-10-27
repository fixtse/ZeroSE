import type { SpeechQuery, SpeechPage, SpeechEngine, SpeechVoice } from '../domain/speech.js';
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
  addMessage(session: string, role: string, text: string, remember?: boolean): Promise<void>;
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
    embeddingSpace?: string,
  ): Promise<void>;
  searchMemory(
    session: string,
    query: string,
    vector: number[] | undefined,
    categories: string[],
    start?: string,
    end?: string,
    embeddingSpace?: string,
  ): Promise<MemoryMatch[]>;
  readMemory(session: string, id: string): Promise<MemoryMatch | undefined>;
  memoryCatalog(session: string): Promise<{ categories: string[]; tags: string[] }>;
  pendingMemoryMessages(session: string): Promise<PendingMemoryMessage[]>;
  pendingMemorySessions(): Promise<string[]>;
  markConsolidated(session: string, ids: number[]): Promise<void>;
}
export interface EmbeddingsPort {
  readonly enabled: boolean;
  readonly space?: string;
  resolve?(): Promise<EmbeddingsPort>;
  embed(text: string, taskType: string, signal?: AbortSignal): Promise<number[]>;
}
export interface MemoryReranker {
  rank(
    session: string,
    query: string,
    candidates: MemoryMatch[],
    signal?: AbortSignal,
  ): Promise<MemoryMatch[]>;
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
}
export interface AgentPort {
  userCommand?(session: string, text: string): Promise<string | undefined>;
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
  forecast(signal?: AbortSignal, type?: 'daily' | 'hourly'): Promise<unknown>;
}
export interface HomeAssistantToolsPort extends HomeAssistantPort {
  location(signal?: AbortSignal): Promise<unknown>;
  locationEntities?(
    search: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  locationEntity?(entity: string, signal?: AbortSignal): Promise<unknown>;
  distance?(first: string, second: string, signal?: AbortSignal): Promise<unknown>;
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
export interface DocumentCreateOptions {
  documentId?: string;
  mode?: 'replace' | 'append';
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
  createDocument(
    title: string,
    html: string,
    signal?: AbortSignal,
    options?: DocumentCreateOptions,
  ): Promise<unknown>;
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

export interface SpeechPort {
  engines(
    kind: 'stt' | 'tts',
    query: SpeechQuery,
    signal: AbortSignal,
  ): Promise<SpeechPage<SpeechEngine>>;
  voices(
    engine: string,
    language: string,
    query: SpeechQuery,
    signal: AbortSignal,
  ): Promise<SpeechPage<SpeechVoice>>;
  synthesize(
    text: string,
    engine: string,
    language: string,
    voice: string,
    signal: AbortSignal,
  ): Promise<Buffer>;
}

/** Bounded vector replacement; memory identities, text and provenance remain unchanged. */
export interface MemoryEmbeddingRepository {
  embeddingBatch(after: string, limit: number): Promise<{ id: string; text: string }[]>;
  replaceEmbedding(id: string, text: string, vector: number[], space: string): Promise<void>;
}
