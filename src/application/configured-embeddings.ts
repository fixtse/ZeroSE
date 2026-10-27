import type { AISettingsPort, EmbeddingSettings, AIProvider } from '../domain/ai.js';
import type { EmbeddingsPort } from './ports.js';

/** Resolve once per memory operation, keeping the vector and its model identity together. */
export class ConfiguredEmbeddings implements EmbeddingsPort {
  readonly enabled = true;
  constructor(
    private settings: AISettingsPort,
    private factory: (settings?: EmbeddingSettings, providers?: AIProvider[]) => EmbeddingsPort,
  ) {}
  async resolve() {
    const settings = await this.settings.read();
    return this.factory(settings.embeddings, settings.providers);
  }
  async embed(text: string, taskType: string, signal?: AbortSignal) {
    return (await this.resolve()).embed(text, taskType, signal);
  }
}
