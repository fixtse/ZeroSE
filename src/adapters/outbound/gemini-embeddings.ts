import type { Config } from '../../domain/config.js';
import type { EmbeddingsPort } from '../../application/ports.js';
import { jsonRequest } from './http.js';
export class GeminiEmbeddings implements EmbeddingsPort {
  constructor(private config: Config['memory']) {}
  get space() {
    return `gemini:${this.config.embeddingModel}:${this.config.embeddingDimensions}`;
  }
  get enabled() {
    return !!this.config.geminiApiKey;
  }
  async embed(content: string, taskType: string, signal?: AbortSignal): Promise<number[]> {
    if (!this.enabled) throw new Error('Gemini embedding key is not configured');
    const result = await jsonRequest(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.embeddingModel)}:embedContent`,
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.config.geminiApiKey },
        body: JSON.stringify({
          model: 'models/' + this.config.embeddingModel,
          content: { parts: [{ text: content }] },
          taskType,
          outputDimensionality: this.config.embeddingDimensions,
        }),
      },
      'Gemini embeddings',
    );
    const values = result.embedding?.values;
    if (
      !Array.isArray(values) ||
      values.length !== this.config.embeddingDimensions ||
      !values.every(Number.isFinite)
    )
      throw new Error('Unexpected embedding dimensions');
    return values;
  }
}
