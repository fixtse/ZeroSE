'use client';
import { useTranslations } from '../i18n/provider';
import { ArrowRight, Play, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type Profile, type SpeechSettings, type CatalogPage } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { ProfileVoicePicker } from './profile-voice-picker';
import { SpeechLanguagePicker } from './speech-language-picker';
import { Field, SelectField } from './settings-fields';
interface Engine {
  id: string;
  name: string;
  languages: string[];
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
  active,
  value,
  onChange,
}: {
  profile: Profile | null;
  active: boolean;
  value: SpeechSettings;
  onChange: (speech: SpeechSettings) => void;
}) {
  const t = useTranslations();
  const { busy, run } = useAdminTask();
  const [engines, setEngines] = useState<{ stt: Engine[]; tts: Engine[] }>({ stt: [], tts: [] }),
    [audio, setAudio] = useState(''),
    [customText, setCustomText] = useState<string>();
  const text = customText ?? t('Hola, soy tu asistente. Esta es una prueba de voz en español.');
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
  const [engineTotals, setEngineTotals] = useState({ stt: 0, tts: 0 });
  const [loadingEngines, setLoadingEngines] = useState(false);
  const [engineRevision, setEngineRevision] = useState(0);
  const engineRequest = useRef<AbortController | null>(null);
  const canListEngines = Boolean(
    profile?.hasHomeAssistant && profile.capabilities.includes('homeAssistant'),
  );

  const homeAssistantUrl = profile?.homeAssistant?.url ?? '';
  const engineHost = URL.canParse(homeAssistantUrl) ? new URL(homeAssistantUrl).host : '';

  async function loadMoreEngines(kind: 'stt' | 'tts') {
    const signal = engineRequest.current?.signal;
    if (!signal || signal.aborted) return;
    const offset = engines[kind].length;
    try {
      const result = await api<CatalogPage<Engine>>(
        path + 'catalog',
        'POST',
        { kind, search: '', offset, limit: 50 },
        signal,
      );
      if (signal.aborted) return;
      setEngines((current) => ({ ...current, [kind]: [...current[kind], ...result.items] }));
      setEngineTotals((current) => ({ ...current, [kind]: result.total }));
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  useEffect(() => {
    if (!active || !canListEngines) return;
    function refreshOnFocus() {
      setEngineRevision((revision) => revision + 1);
    }
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [active, canListEngines]);

  useEffect(() => {
    setEngines({ stt: [], tts: [] });
    setEngineTotals({ stt: 0, tts: 0 });
  }, [path, canListEngines, homeAssistantUrl]);

  useEffect(() => {
    if (!active || !canListEngines) {
      setLoadingEngines(false);
      return;
    }
    const controller = new AbortController();
    engineRequest.current = controller;
    setLoadingEngines(true);
    void Promise.allSettled(
      (['stt', 'tts'] as const).map(async (kind) => {
        const result = await api<CatalogPage<Engine>>(
          path + 'catalog',
          'POST',
          { kind, search: '', offset: 0, limit: 50 },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setEngines((current) => ({ ...current, [kind]: result.items }));
        setEngineTotals((current) => ({ ...current, [kind]: result.total }));
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setLoadingEngines(false);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) {
        void run(async () => {
          throw failure.reason;
        });
      }
    });
    return () => controller.abort();
  }, [active, path, canListEngines, homeAssistantUrl, engineRevision]);

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
  }
  return (
    <section className="settings-section">
      <div className="flex items-center justify-between gap-2">
        <h3>{t('Voz · transcripción y síntesis')}</h3>
        {canListEngines && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            disabled={loadingEngines}
            tooltip={t('Recargar motores de voz')}
            onClick={() => setEngineRevision((revision) => revision + 1)}
          >
            <RefreshCw />
          </Button>
        )}
      </div>
      <p>
        {t(
          'Predeterminado conserva la transcripción actual y Edge TTS. Para consultar motores de Home Assistant, guarda primero su conexión y habilita ese permiso.',
        )}
      </p>
      {canListEngines && engineHost && (
        <p>
          {t('Servidor Home Assistant del perfil')} · {engineHost}
        </p>
      )}
      <div className="settings-grid">
        {(['stt', 'tts'] as const).map((kind) => (
          <div key={kind}>
            <SelectField
              id={'profile-' + kind + '-engine'}
              label={kind === 'stt' ? t('Transcripción (STT)') : t('Síntesis (TTS)')}
              value={value[kind]}
              disabled={busy}
              onChange={(event) => selectEngine(kind, event.target.value)}
            >
              <option value="default">{t('Predeterminado')}</option>
              {value[kind] !== 'default' &&
                !engines[kind].some((engine) => engine.id === value[kind]) && (
                  <option value={value[kind]}>
                    {value[kind]} {t('(guardado)')}
                  </option>
                )}
              {engines[kind].map((engine) => (
                <option value={engine.id} key={engine.id}>
                  {engine.name}
                </option>
              ))}
            </SelectField>
            <SpeechLanguagePicker
              id={'profile-' + kind + '-language'}
              label={t('Idioma ') + kind.toUpperCase()}
              disabled={busy}
              value={value[kind === 'stt' ? 'sttLanguage' : 'ttsLanguage']}
              languages={engines[kind].find((engine) => engine.id === value[kind])?.languages || []}
              useDefaultLanguages={value[kind] === 'default'}
              onChange={(language) => {
                onChange({
                  ...value,
                  [kind + 'Language']: language,
                  ...(kind === 'tts' ? { voice: '' } : {}),
                });
              }}
            />
            {engines[kind].length < engineTotals[kind] && (
              <div className="form-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  tooltip={t('Más motores ') + kind.toUpperCase()}
                  disabled={busy || loadingEngines}
                  onClick={() => void run(() => loadMoreEngines(kind))}
                >
                  <ArrowRight />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      {active && (
        <ProfileVoicePicker
          key={JSON.stringify([path, homeAssistantUrl, value.tts, value.ttsLanguage])}
          catalogPath={path && path + 'catalog'}
          engine={value.tts}
          language={value.ttsLanguage}
          value={value.voice}
          disabled={busy}
          onChange={(voice) => onChange({ ...value, voice })}
        />
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
        <Field
          id="profile-speech-text"
          className="h-12"
          label={t('Texto de prueba')}
          value={text}
          disabled={busy}
          maxLength={1000}
          onChange={(event) => {
            setCustomText(event.target.value);
            clearAudio();
          }}
        />
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
          tooltip={t('Probar voz seleccionada')}
          className="size-12"
        >
          <Play />
        </Button>
      </div>
      {audio && <audio src={audio} controls className="speech-preview" />}
      <small>
        {t(
          'La prueba usa la selección actual sin guardarla. Guarda el perfil para aplicar los cambios.',
        )}
      </small>
    </section>
  );
}
