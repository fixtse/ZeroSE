'use client';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  Copy,
  Cpu,
  ExternalLink,
  Home,
  MessageCircle,
  Plus,
  Rocket,
  Trash2,
} from 'lucide-react';
import { useTranslations } from '../i18n/provider';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { useUrlState } from '../hooks/use-url-state';
import { AISettingsEditor } from './ai-settings';
import { BotSettings } from './bot-settings';
import { HomeAssistantIcon } from './home-assistant-icon';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';

export type SetupMode = '' | 'telegram' | 'home_assistant' | 'both';
export interface Onboarding {
  revision: number;
  mode: SetupMode;
  completed: boolean;
  transcription: 'none' | 'clipse-whisper' | 'legacy' | 'home_assistant';
  transcriptionSources: number;
}
interface Connection {
  url: string;
  callbackUrl: string;
  homeAssistantConnected: boolean;
}
type Step = 'channels' | 'ai' | 'telegram' | 'home-assistant' | 'voice' | 'done';

const integrationUrl = 'https://github.com/fixtse/ha-zero-assistant';
const clipseGuide =
  'https://github.com/fixtse/ZeroSE/blob/main/docs/transcription.md#clipse-whisper';

export function setupSteps(mode: SetupMode): Step[] {
  return [
    'channels',
    'ai',
    ...(mode === 'telegram' || mode === 'both' ? (['telegram'] as const) : []),
    ...(mode === 'home_assistant' || mode === 'both' ? (['home-assistant'] as const) : []),
    'voice',
    'done',
  ];
}

const stepInfo: Record<Step, { label: string; Icon: typeof Cpu }> = {
  channels: { label: 'Canales', Icon: MessageCircle },
  ai: { label: 'Modelo de IA', Icon: Cpu },
  telegram: { label: 'Telegram', Icon: MessageCircle },
  'home-assistant': { label: 'Home Assistant', Icon: Home },
  voice: { label: 'Transcripción', Icon: AudioLines },
  done: { label: 'Listo', Icon: Rocket },
};

function ChannelChoice({
  value,
  onChange,
}: {
  value: SetupMode;
  onChange: (mode: SetupMode) => void;
}) {
  const t = useTranslations();
  const options: { mode: Exclude<SetupMode, ''>; title: string; body: string }[] = [
    {
      mode: 'telegram',
      title: t('Solo Telegram'),
      body: t('Un asistente personal en tu chat. No necesitas Home Assistant.'),
    },
    {
      mode: 'home_assistant',
      title: t('Solo Home Assistant'),
      body: t('Usa Zero como agente de conversación en Assist, sin bot de Telegram.'),
    },
    {
      mode: 'both',
      title: t('Telegram y Home Assistant'),
      body: t('Comparte memoria y permisos entre el chat y la voz de tu casa.'),
    },
  ];
  return (
    <div className="choice-grid" role="radiogroup" aria-label={t('¿Dónde usarás Zero?')}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === option.mode}
          key={option.mode}
          className="choice-card"
          data-selected={value === option.mode}
          onClick={() => onChange(option.mode)}
        >
          <span className="choice-icons" aria-hidden="true">
            {option.mode !== 'home_assistant' && <MessageCircle />}
            {option.mode !== 'telegram' && <HomeAssistantIcon />}
          </span>
          <strong>{option.title}</strong>
          <span>{option.body}</span>
          <span className="choice-check" aria-hidden="true">
            <Check />
          </span>
        </button>
      ))}
    </div>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-value">
      <span>{label}</span>
      <code>{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        tooltip={copied ? t('Copiado') : t('Copiar')}
        aria-label={t('Copiar') + ' ' + label}
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function HomeAssistantStep({ connection }: { connection?: Connection }) {
  const t = useTranslations();
  return (
    <div className="setup-stack">
      <div className={connection?.homeAssistantConnected ? 'status-note ok' : 'status-note'}>
        {connection?.homeAssistantConnected ? <Check /> : <HomeAssistantIcon />}
        {connection?.homeAssistantConnected
          ? t('Home Assistant ya está conectado.')
          : t('Home Assistant aún no está conectado.')}
      </div>
      <ol className="setup-list">
        <li>
          <strong>{t('Instala la integración ZeroSE desde HACS.')}</strong>
          <span>
            {t('Añade el repositorio como integración personalizada y reinicia Home Assistant.')}{' '}
            <a href={integrationUrl} target="_blank" rel="noreferrer" className="text-link">
              {t('Abrir repositorio')} <ExternalLink size={12} />
            </a>
          </span>
        </li>
        <li>
          <strong>{t('Añade la integración en Ajustes → Dispositivos y servicios.')}</strong>
          <span>
            {t(
              'Zero se anuncia en tu red local; si no aparece, usa esta dirección. Home Assistant te devolverá aquí para aprobar la conexión.',
            )}
          </span>
          {connection && <CopyValue label={t('URL de Zero')} value={connection.url} />}
        </li>
        <li>
          <strong>{t('Aprueba la conexión y elige el perfil.')}</strong>
          <span>
            {t(
              'Después, selecciona Zero como agente de conversación en tu canalización de Assist.',
            )}
          </span>
        </li>
      </ol>
    </div>
  );
}

function VoiceStep({
  onboarding,
  onSaved,
}: {
  onboarding: Onboarding;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations();
  const { busy, run, setNotice } = useAdminTask();
  const [provider, setProvider] = useState<'none' | 'clipse-whisper'>(
    onboarding.transcription === 'clipse-whisper' ? 'clipse-whisper' : 'none',
  );
  const [urls, setUrls] = useState<string[]>(['']);
  const filled = urls.map((url) => url.trim()).filter(Boolean);
  return (
    <form
      className="setup-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await api('/v1/admin/setup/onboarding', 'PUT', {
            revision: onboarding.revision,
            transcription: { provider, urls: provider === 'none' ? [] : filled },
          });
          await onSaved();
          setNotice(t('Transcripción guardada.'));
        });
      }}
    >
      <div className="choice-grid two" role="radiogroup" aria-label={t('Transcripción de audio')}>
        <button
          type="button"
          role="radio"
          aria-checked={provider === 'none'}
          className="choice-card"
          data-selected={provider === 'none'}
          onClick={() => setProvider('none')}
        >
          <strong>{t('Sin transcripción por ahora')}</strong>
          <span>
            {t(
              'Zero responderá a texto, imágenes y documentos. Los audios recibirán un aviso. Puedes asignar un motor de Home Assistant a cada perfil.',
            )}
          </span>
          <span className="choice-check" aria-hidden="true">
            <Check />
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={provider === 'clipse-whisper'}
          className="choice-card"
          data-selected={provider === 'clipse-whisper'}
          onClick={() => setProvider('clipse-whisper')}
        >
          <strong>ClipSE Whisper</strong>
          <span>
            {t(
              'Servicio Whisper autoalojado. Añade uno o varios servidores y Zero repartirá la carga entre ellos.',
            )}
          </span>
          <span className="choice-check" aria-hidden="true">
            <Check />
          </span>
        </button>
      </div>
      {onboarding.transcriptionSources > 0 && provider === 'clipse-whisper' && (
        <p className="setup-hint">
          {t(
            'Ya hay {count} fuente(s) guardada(s). Deja la lista vacía para conservarlas o escribe la lista completa para sustituirlas.',
            { count: onboarding.transcriptionSources },
          )}
        </p>
      )}
      {provider === 'clipse-whisper' && (
        <div className="source-list">
          {urls.map((url, index) => (
            <div className="source-row" key={index}>
              <Label htmlFor={'setup-asr-' + index} className="sr-only">
                {t('URL de ClipSE Whisper {count}', { count: index + 1 })}
              </Label>
              <Input
                id={'setup-asr-' + index}
                type="url"
                inputMode="url"
                placeholder="http://192.168.1.20:8000/transcribe"
                value={url}
                onChange={(event) =>
                  setUrls(urls.map((value, i) => (i === index ? event.target.value : value)))
                }
              />
              <Button
                type="button"
                variant="ghost"
                className="danger"
                size="icon-sm"
                disabled={urls.length === 1}
                tooltip={t('Quitar fuente')}
                onClick={() => setUrls(urls.filter((_, i) => i !== index))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={urls.length >= 16}
            onClick={() => setUrls([...urls, ''])}
          >
            <Plus /> {t('Añadir servidor')}
          </Button>
          <p className="setup-hint">
            {t(
              'Usa la URL completa de /transcribe. ¿Aún no tienes ClipSE Whisper? Sigue la guía para ejecutarlo con Docker.',
            )}{' '}
            <a href={clipseGuide} target="_blank" rel="noreferrer" className="text-link">
              {t('Ver guía')} <ExternalLink size={12} />
            </a>
          </p>
        </div>
      )}
      <div className="setup-inline-actions">
        <Button
          disabled={
            busy ||
            (provider === 'clipse-whisper' && !filled.length && !onboarding.transcriptionSources)
          }
        >
          <Check /> {t('Guardar transcripción')}
        </Button>
      </div>
    </form>
  );
}

export function SetupWizard({ onFinished }: { onFinished: () => void }) {
  const t = useTranslations();
  const { busy, run, setNotice } = useAdminTask();
  const [onboarding, setOnboarding] = useState<Onboarding>();
  const [connection, setConnection] = useState<Connection>();
  const [step, setStep] = useUrlState('setupStep', 'channels');
  const [mode, setMode] = useState<SetupMode>('');
  async function load() {
    const [state, status] = await Promise.all([
      api<Onboarding>('/v1/admin/setup/onboarding'),
      api<Connection>('/v1/admin/setup/connection'),
    ]);
    setOnboarding(state);
    setConnection(status);
    setMode((current) => current || state.mode);
  }
  useEffect(() => {
    void run(load);
  }, []);
  const steps = setupSteps(mode);
  const current = (steps.includes(step as Step) ? step : 'channels') as Step;
  const index = steps.indexOf(current);
  async function persist(patch: Partial<Pick<Onboarding, 'mode' | 'completed'>>) {
    if (!onboarding) return;
    await api('/v1/admin/setup/onboarding', 'PUT', { revision: onboarding.revision, ...patch });
    await load();
  }
  function next() {
    void run(async () => {
      if (current === 'channels') {
        if (!mode) throw new Error(t('Elige dónde usarás Zero.'));
        if (mode !== onboarding?.mode) await persist({ mode });
      }
      if (current === 'done') {
        await persist({ completed: true });
        setNotice(t('Configuración inicial completada.'));
        onFinished();
        return;
      }
      setStep(steps[index + 1]!);
    });
  }
  if (!onboarding) return <p>{t('Cargando configuración…')}</p>;
  const { label, Icon } = stepInfo[current];
  return (
    <section className="setup-wizard" aria-labelledby="setup-title">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('CONFIGURACIÓN INICIAL')}</div>
          <h1 id="setup-title">{t('Pon en marcha tu Zero.')}</h1>
          <p>{t('Unos pocos pasos. Todo se puede cambiar después en Ajustes.')}</p>
        </div>
      </div>
      <ol className="stepper" aria-label={t('Pasos')}>
        {steps.map((item, position) => {
          const { label: name, Icon: StepIcon } = stepInfo[item];
          const state = position < index ? 'done' : position === index ? 'current' : 'todo';
          return (
            <li
              key={item}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <button
                type="button"
                disabled={busy || position > index || (position > 0 && !mode)}
                onClick={() => setStep(item)}
              >
                <span className="step-dot">
                  {state === 'done' ? <Check /> : <StepIcon aria-hidden="true" />}
                </span>
                <span className="step-label">{t(name)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <Card className="panel setup-panel">
        <div className="setup-panel-title">
          <span className="setup-icon">
            <Icon aria-hidden="true" />
          </span>
          <div>
            <small>
              {t('Paso {current} de {total}', { current: index + 1, total: steps.length })}
            </small>
            <h2>{t(label)}</h2>
          </div>
        </div>
        {current === 'channels' && (
          <>
            <p>{t('¿Dónde usarás Zero? Podrás añadir el otro canal más adelante.')}</p>
            <ChannelChoice value={mode} onChange={setMode} />
          </>
        )}
        {current === 'ai' && (
          <>
            <p>
              {t(
                'Añade una conexión (OpenAI, Anthropic, OpenRouter, Ollama, un endpoint compatible o Codex) y al menos un modelo. Guarda antes de continuar.',
              )}
            </p>
            <div className="setup-embedded">
              <AISettingsEditor />
            </div>
          </>
        )}
        {current === 'telegram' && (
          <>
            <p>
              {t(
                'Crea un bot con @BotFather, pega su token y guarda. Después escribe a tu bot: tu chat aparecerá pendiente en Usuarios para que lo apruebes.',
              )}
            </p>
            <div className="setup-embedded">
              <BotSettings id="zero" name="Zero" />
            </div>
          </>
        )}
        {current === 'home-assistant' && <HomeAssistantStep connection={connection} />}
        {current === 'voice' && (
          <>
            <p>
              {t(
                'La transcripción convierte notas de voz y vídeos en texto. Es opcional. Las respuestas por voz y Assist no dependen de esta opción.',
              )}
            </p>
            <VoiceStep key={onboarding.revision} onboarding={onboarding} onSaved={load} />
          </>
        )}
        {current === 'done' && (
          <div className="setup-stack">
            <p>{t('Todo listo. Revisa el resumen y termina.')}</p>
            <ul className="summary-list">
              <li>
                <MessageCircle aria-hidden="true" />
                {mode === 'both'
                  ? t('Telegram y Home Assistant')
                  : mode === 'telegram'
                    ? t('Solo Telegram')
                    : t('Solo Home Assistant')}
              </li>
              <li>
                <AudioLines aria-hidden="true" />
                {onboarding.transcription === 'none'
                  ? t('Sin transcripción de audio')
                  : onboarding.transcription === 'clipse-whisper'
                    ? t('ClipSE Whisper · {count} servidor(es)', {
                        count: onboarding.transcriptionSources,
                      })
                    : onboarding.transcription === 'home_assistant'
                      ? t('Motor de Home Assistant')
                      : t('Servicio de transcripción compatible')}
              </li>
              {(mode === 'home_assistant' || mode === 'both') && (
                <li>
                  <Home aria-hidden="true" />
                  {connection?.homeAssistantConnected
                    ? t('Home Assistant conectado')
                    : t('Home Assistant pendiente de conectar')}
                </li>
              )}
            </ul>
          </div>
        )}
        <div className="setup-footer">
          <Button
            type="button"
            variant="ghost"
            disabled={busy || index === 0}
            onClick={() => setStep(steps[index - 1]!)}
          >
            <ArrowLeft /> {t('Atrás')}
          </Button>
          <div className="setup-footer-end">
            {current !== 'done' && current !== 'channels' && (
              <Button type="button" variant="ghost" disabled={busy} onClick={next}>
                {t('Omitir')}
              </Button>
            )}
            <Button
              type="button"
              disabled={busy || (current === 'channels' && !mode)}
              onClick={next}
            >
              {current === 'done' ? (
                <>
                  <Rocket /> {t('Terminar')}
                </>
              ) : (
                <>
                  {t('Continuar')} <ArrowRight />
                </>
              )}
            </Button>
          </div>
        </div>
      </Card>
    </section>
  );
}
