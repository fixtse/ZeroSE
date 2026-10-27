export interface AssistantImage {
  image: string | null;
  revision: number;
}
export interface AssistantImageRepository {
  get(id: string): Promise<AssistantImage>;
  save(id: string, image: string | null, revision: number): Promise<AssistantImage | undefined>;
}
export interface AssistantPhotoPort {
  available(id: string): Promise<boolean>;
  get(id: string, signal: AbortSignal): Promise<string | null>;
  set(id: string, jpeg: Uint8Array, signal: AbortSignal): Promise<void>;
}

export interface AssistantImageGenerator {
  available(): Promise<boolean>;
  generate(prompt: string, signal: AbortSignal, references?: readonly string[]): Promise<string>;
}
