'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, AudioLines, Cpu, MessageCircle, Rocket, UserPlus } from 'lucide-react';
import { useTranslations } from '../i18n/provider';
import { api } from '../lib/api';
import { HomeAssistantIcon } from './home-assistant-icon';
import { Button } from './ui/button';
import { Card } from './ui/card';
import type { Onboarding } from './setup-wizard';

interface Status {
  onboarding?: Onboarding;
  ai?: boolean;
  telegram?: boolean;
  homeAssistant?: boolean;
  pending?: number;
}
type Tone = 'ok' | 'warn' | 'off';

function Tile({
  icon,
  title,
  detail,
  tone,
  action,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  tone: Tone;
  action: string;
  onAction: () => void;
}) {
  return (
    <Card className="status-tile" data-tone={tone}>
      <div className="status-tile-head">
        <span className="status-tile-icon">{icon}</span>
        <span className="status-dot" aria-hidden="true" />
      </div>
      <strong>{title}</strong>
      <span className="status-detail">{detail}</span>
      <Button variant="ghost" size="sm" className="status-action" onClick={onAction}>
        {action} <ArrowRight />
      </Button>
    </Card>
  );
}

const settled = <T,>(promise: Promise<T>) => promise.catch(() => undefined);

export function Overview({
  navigate,
  openSetup,
}: {
  navigate: (page: string, params?: Record<string, string>) => void;
  openSetup: () => void;
}) {
  const t = useTranslations();
  const [status, setStatus] = useState<Status>();
  useEffect(() => {
    let active = true;
    // Each probe is independent: one unreachable integration must not hide the others.
    void Promise.all([
      settled(api<Onboarding>('/v1/admin/setup/onboarding')),
      settled(api<{ providers: unknown[]; models: unknown[] }>('/v1/admin/ai')),
      settled(
        api<{ configured: boolean; enabled: boolean }>('/v1/admin/setup/assistants/zero/telegram'),
      ),
      settled(api<{ homeAssistantConnected: boolean }>('/v1/admin/setup/connection')),
      settled(api<{ total: number }>('/v1/admin/profiles?limit=1&offset=0&pending=true&search=')),
    ]).then(([onboarding, ai, telegram, connection, pending]) => {
      if (!active) return;
      setStatus({
        onboarding,
        ai: ai ? ai.providers.length > 0 && ai.models.length > 0 : undefined,
        telegram: telegram ? telegram.configured && telegram.enabled : undefined,
        homeAssistant: connection?.homeAssistantConnected,
        pending: pending?.total,
      });
    });
    return () => {
      active = false;
    };
  }, []);
  const mode = status?.onboarding?.mode || '';
  const wantsTelegram = mode !== 'home_assistant';
  const wantsHomeAssistant = mode === 'home_assistant' || mode === 'both';
  const transcription = status?.onboarding?.transcription;
  return (
    <section className="overview" aria-labelledby="overview-title">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('INICIO')}</div>
          <h1 id="overview-title">{t('Tu Zero, de un vistazo.')}</h1>
          <p>{t('Estado de los canales, el modelo de IA y la voz.')}</p>
        </div>
      </div>
      {status?.onboarding && !status.onboarding.completed && (
        <Card className="panel setup-callout">
          <span className="setup-icon">
            <Rocket aria-hidden="true" />
          </span>
          <div>
            <h2>{t('Termina la configuración inicial.')}</h2>
            <p>
              {t(
                'Elige tus canales, conecta un modelo de IA y decide si quieres transcribir audios.',
              )}
            </p>
          </div>
          <Button onClick={openSetup}>
            {t('Continuar configuración')} <ArrowRight />
          </Button>
        </Card>
      )}
      <div className="status-grid" aria-busy={!status}>
        <Tile
          icon={<Cpu />}
          title={t('Modelo de IA')}
          tone={status?.ai ? 'ok' : status ? 'warn' : 'off'}
          detail={
            !status
              ? t('Comprobando…')
              : status.ai
                ? t('Conexión y modelo configurados')
                : t('Añade una conexión y un modelo')
          }
          action={t('Proveedores IA')}
          onAction={() => navigate('ai')}
        />
        <Tile
          icon={<MessageCircle />}
          title="Telegram"
          tone={status?.telegram ? 'ok' : wantsTelegram && status ? 'warn' : 'off'}
          detail={
            !status
              ? t('Comprobando…')
              : status.telegram
                ? t('Bot activo')
                : wantsTelegram
                  ? t('Bot sin configurar')
                  : t('Opcional')
          }
          action={t('Asistentes')}
          onAction={() => navigate('settings', { assistant: 'zero' })}
        />
        <Tile
          icon={<HomeAssistantIcon />}
          title="Home Assistant"
          tone={status?.homeAssistant ? 'ok' : wantsHomeAssistant && status ? 'warn' : 'off'}
          detail={
            !status
              ? t('Comprobando…')
              : status.homeAssistant
                ? t('Conectado')
                : wantsHomeAssistant
                  ? t('Pendiente de conectar')
                  : t('Opcional')
          }
          action={t('Ajustes')}
          onAction={() => navigate('services', { settingsTab: 'homeAssistant' })}
        />
        <Tile
          icon={<AudioLines />}
          title={t('Transcripción')}
          tone={!status ? 'off' : transcription && transcription !== 'none' ? 'ok' : 'off'}
          detail={
            !status
              ? t('Comprobando…')
              : transcription === 'clipse-whisper'
                ? t('ClipSE Whisper · {count} servidor(es)', {
                    count: status.onboarding?.transcriptionSources ?? 0,
                  })
                : transcription === 'home_assistant'
                  ? t('Motor de Home Assistant')
                  : transcription === 'legacy'
                    ? t('Servicio de transcripción compatible')
                    : t('Desactivada')
          }
          action={t('Vídeo y voz')}
          onAction={() => navigate('services', { settingsTab: 'media' })}
        />
        <Tile
          icon={<UserPlus />}
          title={t('Solicitudes pendientes')}
          tone={status?.pending ? 'warn' : 'off'}
          detail={
            status?.pending === undefined
              ? t('Comprobando…')
              : status.pending
                ? t('{count} pendiente(s) de aprobar', { count: status.pending })
                : t('Nada pendiente')
          }
          action={t('Usuarios')}
          onAction={() => navigate('people')}
        />
      </div>
      {status?.onboarding?.completed && (
        <p className="overview-footnote">
          <Button variant="link" className="p-0" onClick={openSetup}>
            {t('Repetir la configuración inicial')}
          </Button>
        </p>
      )}
    </section>
  );
}
