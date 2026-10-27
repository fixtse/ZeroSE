'use client';
import { ArrowRight, Check, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type Profile, type SpeechSettings, type CatalogPage } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Field, SelectField } from './settings-fields';
interface Engine {
  id: string;
  name: string;
  languages: string[];
}
interface Voice {
  id: string;
  name: string;
}
export const defaultSpeech: SpeechSettings = {
  stt: 'default',
  sttLanguage: 'es-ES',
  tts: 'default',
  ttsLanguage: 'es-ES',
  voice: '',
};
export function ProfileSpeech({
  profile,
  value,
  onChange,
}: {
  profile: Profile | null;
  value: SpeechSettings;
  onChange: (speech: SpeechSettings) => void;
}) {
  const { busy, run } = useAdminTask();
  const [engines, setEngines] = useState<{ stt: Engine[]; tts: Engine[] }>({ stt: [], tts: [] }),
    [voices, setVoices] = useState<Voice[]>([]),
    [voiceOffset, setVoiceOffset] = useState(0),
    [voiceTotal, setVoiceTotal] = useState(0),
    [query, setQuery] = useState(''),
    [audio, setAudio] = useState(''),
    [text, setText] = useState('Hola, soy tu asistente. Esta es una prueba de voz en español.');
  const audioRef = useRef('');
  const alive = useRef(true);
  function clearAudio() {
    if (audioRef.current) URL.revokeObjectURL(audioRef.current);
    audioRef.current = '';
    setAudio('');
  }
  useEffect(() => {
    clearAudio();
  }, [value.stt, value.tts, value.ttsLanguage, value.voice]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (audioRef.current) URL.revokeObjectURL(audioRef.current);
    };
  }, []);
  const path = profile
    ? '/v1/admin/profiles/' + profile.bot + '/' + profile.chatId + '/speech/'
    : '';
  async function catalog<T>(input: unknown) {
    if (!profile) throw new Error('Guarda primero el perfil y su conexión.');
    return api<CatalogPage<T>>(path + 'catalog', 'POST', input);
  }
  async function loadEngines(kind: 'stt' | 'tts', append = false) {
    const previous = append ? engines[kind] : [];
    const result = await catalog<Engine>({ kind, search: '', offset: previous.length, limit: 50 });
    setEngines((current) => ({ ...current, [kind]: [...previous, ...result.items] }));
    return result;
  }
  const [engineTotals, setEngineTotals] = useState({ stt: 0, tts: 0 });
  async function loadVoices(append = false) {
    if (value.tts === 'default') {
      setVoices([]);
      setVoiceTotal(0);
      return;
    }
    const result = await catalog<Voice>({
      kind: 'voices',
      engine: value.tts,
      language: value.ttsLanguage,
      search: query,
      offset: append ? voiceOffset : 0,
      limit: 50,
    });
    setVoices(append ? [...voices, ...result.items] : result.items);
    setVoiceOffset((append ? voiceOffset : 0) + result.items.length);
    setVoiceTotal(result.total);
  }
  function selectEngine(kind: 'stt' | 'tts', id: string) {
    const languages = engines[kind].find((item) => item.id === id)?.languages || [
      value[(kind + 'Language') as 'sttLanguage' | 'ttsLanguage'],
    ];
    onChange({
      ...value,
      [kind]: id,
      [kind + 'Language']: languages.includes('es-ES') ? 'es-ES' : languages[0] || 'es-ES',
      ...(kind === 'tts' ? { voice: '' } : {}),
    });
    if (kind === 'tts') {
      setVoices([]);
      setVoiceOffset(0);
      setVoiceTotal(0);
    }
  }
  return (
    <details className="settings-section">
      <summary>Voz · transcripción y síntesis</summary>
      <p>
        Predeterminado conserva la transcripción actual y Edge TTS. Para consultar motores de Home
        Assistant, guarda primero su conexión y habilita ese permiso.
      </p>
      <div className="form-actions">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !profile}
          onClick={() =>
            void run(async () => {
              const [stt, tts] = await Promise.all([loadEngines('stt'), loadEngines('tts')]);
              setEngineTotals({ stt: stt.total, tts: tts.total });
            })
          }
          size="icon"
          tooltip="Cargar motores disponibles"
        >
          <Check />
        </Button>
      </div>
      <div className="settings-grid">
        {(['stt', 'tts'] as const).map((kind) => (
          <div key={kind}>
            <SelectField
              id={'profile-' + kind + '-engine'}
              label={kind === 'stt' ? 'Transcripción (STT)' : 'Síntesis (TTS)'}
              value={value[kind]}
              disabled={busy}
              onChange={(event) => selectEngine(kind, event.target.value)}
            >
              <option value="default">Predeterminado</option>
              {value[kind] !== 'default' &&
                !engines[kind].some((engine) => engine.id === value[kind]) && (
                  <option value={value[kind]}>{value[kind]} (guardado)</option>
                )}
              {engines[kind].map((engine) => (
                <option value={engine.id} key={engine.id}>
                  {engine.name}
                </option>
              ))}
            </SelectField>
            <Field
              id={'profile-' + kind + '-language'}
              label={'Idioma ' + kind.toUpperCase()}
              disabled={busy}
              value={value[kind === 'stt' ? 'sttLanguage' : 'ttsLanguage']}
              pattern="(?:[a-zA-Z0-9_]|-){1,50}"
              required
              list={'profile-' + kind + '-languages'}
              onChange={(event) => {
                onChange({
                  ...value,
                  [kind + 'Language']: event.target.value,
                  ...(kind === 'tts' ? { voice: '' } : {}),
                });
                if (kind === 'tts') {
                  setVoices([]);
                  setVoiceOffset(0);
                  setVoiceTotal(0);
                }
              }}
            />
            <datalist id={'profile-' + kind + '-languages'}>
              {(engines[kind].find((engine) => engine.id === value[kind])?.languages || []).map(
                (language) => (
                  <option key={language} value={language} />
                ),
              )}
            </datalist>
            {engines[kind].length < engineTotals[kind] && (
              <div className="form-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  tooltip={'Más motores ' + kind.toUpperCase()}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await loadEngines(kind, true);
                    })
                  }
                >
                  <ArrowRight />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <SelectField
        id="profile-tts-voice"
        label="Voz TTS"
        value={value.voice}
        disabled={busy}
        onChange={(event) => onChange({ ...value, voice: event.target.value })}
      >
        <option value="">Voz predeterminada del motor</option>
        {value.voice && !voices.some((voice) => voice.id === value.voice) && (
          <option value={value.voice}>{value.voice} (guardada)</option>
        )}
        {voices.map((voice) => (
          <option value={voice.id} key={voice.id}>
            {voice.name}
          </option>
        ))}
      </SelectField>
      <Field
        id="profile-voice-search"
        label="Buscar voces"
        value={query}
        disabled={busy}
        maxLength={200}
        onChange={(event) => {
          setQuery(event.target.value);
          setVoices([]);
          setVoiceOffset(0);
          setVoiceTotal(0);
        }}
      />
      <div className="form-actions">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !profile || value.tts === 'default'}
          onClick={() => void run(() => loadVoices())}
          size="icon"
          tooltip="Buscar voces"
        >
          <Search />
        </Button>
        {voiceOffset < voiceTotal && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => loadVoices(true))}
            size="icon"
            tooltip="Más voces"
          >
            <Check />
          </Button>
        )}
        <small>{voiceTotal ? voiceOffset + ' de ' + voiceTotal + ' voces' : ''}</small>
      </div>
      <Field
        id="profile-speech-text"
        label="Texto de prueba"
        value={text}
        disabled={busy}
        maxLength={1000}
        onChange={(event) => {
          setText(event.target.value);
          clearAudio();
        }}
      />
      <div className="form-actions">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !profile}
          onClick={() =>
            void run(async () => {
              clearAudio();
              const result = await api<{ audio: string; mime: string }>(path + 'preview', 'POST', {
                speech: value,
                text,
              });
              if (!alive.current) return;
              const bytes = Uint8Array.from(atob(result.audio), (character) =>
                character.charCodeAt(0),
              );
              const url = URL.createObjectURL(new Blob([bytes], { type: result.mime }));
              audioRef.current = url;
              setAudio(url);
            })
          }
          size="icon"
          tooltip="Probar voz seleccionada"
        >
          <Check />
        </Button>
      </div>
      {audio && <audio src={audio} controls className="speech-preview" />}
      <small>
        La prueba usa la selección actual sin guardarla. Guarda el perfil para aplicar los cambios.
      </small>
    </details>
  );
}
