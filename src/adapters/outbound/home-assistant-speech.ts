import type { Config } from '../../domain/config.js';
import type { SpeechEngine, SpeechQuery, SpeechVoice } from '../../domain/speech.js';
import type { SpeechPort } from '../../application/ports.js';
import { boundedBody, jsonBody, jsonRequest, RemoteError } from './http.js';

/** Speech discovery is requested by the admin UI, never added to agent instructions. */
export class HomeAssistantSpeech implements SpeechPort {
  constructor(
    private config: Config['homeAssistant'],
    private maxBytes = 20_000_000,
  ) {}
  private url(path: string) {
    if (!this.config.token || !this.config.url)
      throw new Error('Home Assistant is not configured for this chat');
    return this.config.url.replace(/\/$/, '') + path;
  }
  private headers() {
    return { Authorization: `Bearer ${this.config.token}` };
  }
  private command(command: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    signal.throwIfAborted();
    const url = new URL(this.url('/api/websocket'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        socket.onclose = socket.onerror = socket.onmessage = null;
        socket.close();
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new Error('Home Assistant speech request cancelled'));
      const timer = setTimeout(
        () => finish(new Error('Home Assistant speech request timed out')),
        15_000,
      );
      signal.addEventListener('abort', abort, { once: true });
      socket.onerror = () => finish(new Error('Home Assistant speech connection failed'));
      socket.onclose = () => finish(new Error('Home Assistant speech connection closed'));
      socket.onmessage = (event) => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 2_000_000)
            throw new Error('Invalid speech catalog');
          const message = JSON.parse(event.data);
          if (message.type === 'auth_required')
            socket.send(JSON.stringify({ type: 'auth', access_token: this.config.token }));
          else if (message.type === 'auth_ok') socket.send(JSON.stringify({ id: 1, ...command }));
          else if (message.type === 'auth_invalid')
            finish(new Error('Home Assistant speech authentication failed'));
          else if (message.type === 'result' && message.id === 1) {
            if (!message.success) finish(new Error('Home Assistant speech command is unavailable'));
            else finish(undefined, message.result);
          }
        } catch {
          finish(new Error('Home Assistant returned an invalid speech response'));
        }
      };
    });
  }
  private page<T extends { id: string; name: string }>(items: T[], query: SpeechQuery) {
    const filtered = items.filter((item) =>
      `${item.id} ${item.name}`.toLowerCase().includes(query.search.toLowerCase()),
    );
    return {
      items: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
    };
  }
  async engines(kind: 'stt' | 'tts', query: SpeechQuery, signal: AbortSignal) {
    const result = await this.command({ type: `${kind}/engine/list` }, signal);
    const items: SpeechEngine[] = (result.providers || []).map((p: any) => ({
      id: p.engine_id,
      name: p.name || p.engine_id,
      languages: Array.isArray(p.supported_languages) ? p.supported_languages : [],
    }));
    return this.page(items, query);
  }
  async voices(engine: string, language: string, query: SpeechQuery, signal: AbortSignal) {
    const result = await this.command(
      { type: 'tts/engine/voices', engine_id: engine, language },
      signal,
    );
    const items: SpeechVoice[] = (result.voices || []).map((v: any) => ({
      id: v.voice_id,
      name: v.name || v.voice_id,
    }));
    return this.page(items, query);
  }
  async transcribe(audio: Buffer, engine: string, language: string, signal: AbortSignal) {
    const result = await jsonRequest(
      this.url('/api/stt/' + encodeURIComponent(engine)),
      {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'audio/wav',
          'X-Speech-Content': `format=wav; codec=pcm; sample_rate=16000; bit_rate=16; channel=1; language=${language}`,
        },
        body: new Uint8Array(audio),
        signal,
      },
      'Home Assistant speech transcription',
    );
    if (result.result !== 'success' || typeof result.text !== 'string')
      throw new Error('Home Assistant speech transcription failed');
    return result.text;
  }
  async synthesize(
    text: string,
    engine: string,
    language: string,
    voice: string,
    signal: AbortSignal,
  ) {
    const result = await jsonRequest(
      this.url('/api/tts_get_url'),
      {
        method: 'POST',
        ...jsonBody({
          engine_id: engine,
          message: text,
          language,
          cache: false,
          ...(voice ? { options: { voice } } : {}),
        }),
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        signal,
      },
      'Home Assistant speech synthesis',
    );
    // Use only HA's same-origin proxy path; never forward credentials to returned external URLs.
    if (typeof result.path !== 'string' || !/^\/api\/tts_proxy\/[a-zA-Z0-9_.-]+$/.test(result.path))
      throw new Error('Home Assistant returned an invalid speech audio path');
    const response = await fetch(this.url(result.path), {
      headers: this.headers(),
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new RemoteError('Home Assistant speech audio', response.status);
    const audio = await boundedBody(response, this.maxBytes);
    if (!audio.length) throw new Error('Home Assistant returned empty speech audio');
    return audio;
  }
}
