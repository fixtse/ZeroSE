import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SpeechQuery, SpeechVoice } from '../../domain/speech.js';

const exec = promisify(execFile);
type Voice = SpeechVoice & { language: string };
/** Query the installed Edge TTS client, including its supported service handshake. */
export class EdgeSpeechCatalog {
  private cached?: { expires: number; voices: Voice[] };
  private loading?: Promise<Voice[]>;
  private async all(signal: AbortSignal) {
    if (this.cached && this.cached.expires > Date.now()) return this.cached.voices;
    if (!this.loading) {
      this.loading = exec('edge-tts', ['--list-voices'], {
        timeout: 15000,
        signal,
        maxBuffer: 2_000_000,
      })
        .then(({ stdout }) => {
          const voices = stdout.split('\n').flatMap((line) => {
            const id = line.trim().split(/\s+/)[0];
            const match = /^([a-z]{2,3}-[A-Za-z0-9-]+)-[^-]+Neural$/.exec(id);
            return match ? [{ id, name: id, language: match[1] }] : [];
          });
          if (!voices.length) throw new Error('Edge TTS returned no voices');
          this.cached = { expires: Date.now() + 600_000, voices };
          return voices;
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    return this.loading;
  }
  async page(
    kind: 'languages' | 'voices',
    language: string,
    query: SpeechQuery,
    signal: AbortSignal,
  ) {
    const voices = await this.all(signal);
    const items =
      kind === 'languages'
        ? [...new Set(voices.map((voice) => voice.language))].sort().map((id) => ({ id, name: id }))
        : voices.filter((voice) => !language || voice.language === language);
    const filtered = items.filter((item) =>
      (item.id + ' ' + item.name).toLowerCase().includes(query.search.toLowerCase()),
    );
    return {
      items: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
    };
  }
}
