export interface Job {
  id: string;
  session: string;
  payload: any;
  status: string;
  output?: string;
  error?: string;
}
export interface ToolContext {
  session: string;
  jobId: string;
  signal: AbortSignal;
}
export interface MemoryFragment {
  text: string;
  category: string;
  tags: string[];
}
export interface MemoryMatch {
  text: string;
  metadata: { category: string; tags: string[]; created_at: string };
  similarity: number;
}
export interface PendingMemoryMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  created: string;
}
