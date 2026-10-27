export const aiProviderKinds = [
  'codex',
  'openai',
  'openrouter',
  'compatible',
  'ollama',
  'anthropic',
  'home_assistant',
] as const;
export type AIProviderKind = (typeof aiProviderKinds)[number];
export interface AIProvider {
  id: string;
  name: string;
  kind: AIProviderKind;
  baseUrl: string;
  apiKey: string;
  scope?: 'conversation' | 'embeddings' | 'reranking';
}
export const aiEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AIEffort = (typeof aiEfforts)[number];
export interface AIModel {
  id: string;
  label: string;
  provider: string;
  model: string;
  effort?: AIEffort;
}
export interface AISettings {
  revision: number;
  providers: AIProvider[];
  models: AIModel[];
  defaultModel: string;
  embeddings?: EmbeddingSettings;
  reranking?: RerankingSettings;
}
export interface AISettingsPort {
  read(): Promise<AISettings>;
  update(value: AISettings): Promise<boolean>;
  selectNext(session: string, model: string | null): Promise<void>;
  consumeNext(session: string): Promise<string | undefined>;
}

export interface AIModelCatalogQuery {
  search: string;
  offset: number;
  limit: number;
}
export interface AIModelCatalogPage {
  items: { id: string; name: string }[];
  total: number;
}
export type AIModelCatalog = (
  provider: AIProvider,
  query: AIModelCatalogQuery,
  signal: AbortSignal,
) => Promise<AIModelCatalogPage>;

export interface EmbeddingSettings {
  mode: 'default' | 'disabled' | 'gemini' | 'provider';
  provider?: string;
  dimensions?: number;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export const embeddingProviderKinds: readonly AIProviderKind[] = [
  'openai',
  'openrouter',
  'compatible',
  'ollama',
];

export interface RerankingSettings {
  enabled: boolean;
  provider: string;
  model: string;
  api?: 'model' | 'rerank';
  effort?: AIEffort;
}
