import { RemoteError } from './http.js';

/** Raised when no speech-to-text service is configured for the current scope. */
export class TranscriptionUnavailableError extends Error {
  constructor() {
    super('Speech transcription is not configured');
    this.name = 'TranscriptionUnavailableError';
  }
}

/** Normalizes the primary URL plus additional sources into a unique, ordered list. */
export function transcriptionSources(primary: string | undefined, extra: readonly string[] = []) {
  return [...new Set([primary || '', ...extra].map((url) => url.trim()).filter(Boolean))];
}

const cursors = new Map<string, number>();
const cooldowns = new Map<string, number>();
/** A failed source sits out briefly so a dead node does not slow every request. */
export const sourceCooldownMs = 30_000;

/** Network errors, timeouts and 5xx/429 answers move on to the next source; 4xx do not. */
function retriable(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return false;
  if (error instanceof RemoteError) return error.status >= 500 || error.status === 429;
  return !(error instanceof SyntaxError);
}

/**
 * Round-robin load balancing across interchangeable transcription services.
 * Each request starts at the next source and tries every source at most once,
 * so failover is bounded. Sources cooling down after a failure are tried last.
 */
export async function balanced<T>(
  sources: readonly string[],
  signal: AbortSignal,
  attempt: (url: string) => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  if (!sources.length) throw new TranscriptionUnavailableError();
  const key = sources.join('\n');
  const start = (cursors.get(key) ?? 0) % sources.length;
  cursors.set(key, start + 1);
  const rotated = sources.map((_, index) => sources[(start + index) % sources.length]!);
  const time = now();
  const ordered = [
    ...rotated.filter((url) => (cooldowns.get(url) ?? 0) <= time),
    ...rotated.filter((url) => (cooldowns.get(url) ?? 0) > time),
  ];
  let failure: unknown;
  for (const url of ordered) {
    signal.throwIfAborted();
    try {
      const result = await attempt(url);
      cooldowns.delete(url);
      return result;
    } catch (error) {
      failure = error;
      if (!retriable(error, signal)) throw error;
      cooldowns.set(url, now() + sourceCooldownMs);
    }
  }
  throw failure;
}

/** Test helper: forget rotation and cooldown state. */
export function resetTranscriptionPool() {
  cursors.clear();
  cooldowns.clear();
}
