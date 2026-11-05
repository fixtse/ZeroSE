import type { MemoryMode } from './memory.js';
export interface Job {
  id: string;
  session: string;
  payload: any;
  status: string;
  output?: string;
  error?: string;
}
export interface GeneratedImage {
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}
export interface ToolContext {
  session: string;
  jobId: string;
  deadlineAt?: number;
  signal: AbortSignal;
  capabilities?: string[];
  memoryMode?: MemoryMode;
  generatedImages?: GeneratedImage[];
  aiModel?: string;
  aiEffort?: import('./ai.js').AIEffort;
  userQuestion?: boolean;
  telegramUserId?: string;
  source?: 'home_assistant_voice';
}
export interface MemoryRelation {
  subject: string;
  predicate: string;
  object: string;
}
export interface MemoryFragment {
  entities?: string[];
  relations?: MemoryRelation[];
  expiresAt?: string | null;
  text: string;
  summary?: string;
  supersedes?: string[];
  category: string;
  tags: string[];
}
export interface MemoryMatch {
  id: string;
  text: string;
  summary: string | null;
  superseded_by: string | null;
  metadata: {
    category: string;
    tags: string[];
    created_at: string;
    expires_at?: string | null;
    entities?: string[];
    relations?: MemoryRelation[];
  };
  similarity: number;
}
export interface MemorySearchResult {
  id: string;
  summary: string;
  summary_is_excerpt: boolean;
  metadata: MemoryMatch['metadata'];
  similarity: number;
}
export interface PendingMemoryMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  created: string;
}
