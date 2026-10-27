import type { AssistantImageGenerator } from '../../application/assistant-images.js';
import type { AISettingsPort } from '../../domain/ai.js';

/** Uses only the configured default model; never substitutes another model. */
export class ProviderAssistantImageGenerator implements AssistantImageGenerator {
  constructor(
    private settings: AISettingsPort,
    private request: typeof fetch = fetch,
    private codex?: (
      model: string,
      prompt: string,
      signal: AbortSignal,
      references?: readonly string[],
    ) => Promise<string>,
  ) {}
  private async selection(signal: AbortSignal) {
    const settings = await this.settings.read();
    const model = settings.models.find((m) => m.id === settings.defaultModel);
    const provider = settings.providers.find((p) => p.id === model?.provider);
    if (!model || !provider) return;
    if (provider.kind === 'codex' && this.codex) return { model, provider, base: '' };
    if (
      provider.kind === 'openai' &&
      /^(gpt-image-(1-mini|1\.5|2(?:-2026-04-21)?|2\.5-(?:sunburst|flare)(?:-2026-09-08)?)|chatgpt-image-latest)$/.test(
        model.model,
      )
    )
      return { model, provider, base: provider.baseUrl || 'https://api.openai.com/v1' };
    if (provider.kind !== 'openrouter') return;
    const base = provider.baseUrl || 'https://openrouter.ai/api/v1';
    const response = await this.request(base.replace(/\/$/, '') + '/models', {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal,
      redirect: 'error',
    });
    if (!response.ok) return;
    const catalog = (await response.json()) as {
      data?: { id: string; architecture?: { output_modalities?: string[] } }[];
    };
    if (
      catalog.data?.some(
        (m) => m.id === model.model && m.architecture?.output_modalities?.includes('image'),
      )
    )
      return { model, provider, base };
  }
  async available() {
    return !!(await this.selection(AbortSignal.timeout(10000)));
  }
  async generate(prompt: string, signal: AbortSignal, references: readonly string[] = []) {
    const selected = await this.selection(signal);
    if (!selected) throw new Error('Image generation unavailable');
    const { model, provider, base } = selected;
    if (provider.kind === 'codex') return this.codex!(model.model, prompt, signal, references);
    const openrouter = provider.kind === 'openrouter';
    const response = await this.request(
      base.replace(/\/$/, '') +
        (openrouter
          ? '/chat/completions'
          : references.length
            ? '/images/edits'
            : '/images/generations'),
      {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          openrouter
            ? {
                model: model.model,
                messages: [
                  {
                    role: 'user',
                    content: references.length
                      ? [
                          { type: 'text', text: prompt },
                          ...references.map((url) => ({ type: 'image_url', image_url: { url } })),
                        ]
                      : prompt,
                  },
                ],
                modalities: ['image', 'text'],
                stream: false,
              }
            : {
                model: model.model,
                prompt,
                n: 1,
                size: '1024x1024',
                output_format: 'jpeg',
                ...(references.length
                  ? { images: references.map((image_url) => ({ image_url })) }
                  : {}),
              },
        ),
      },
    );
    if (!response.ok) throw new Error('Image generation failed');
    const result = (await response.json()) as {
      data?: { b64_json?: string }[];
      choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
    };
    const image = openrouter
      ? result.choices?.[0]?.message?.images?.[0]?.image_url?.url
      : result.data?.[0]?.b64_json && 'data:image/jpeg;base64,' + result.data[0].b64_json;
    if (
      !image ||
      image.length > 20000000 ||
      !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
    )
      throw new Error('Invalid generated image');
    return image;
  }
}
