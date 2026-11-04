'use client';
import { useTranslations } from '../i18n/provider';
import { ArrowLeft, ArrowRight, Pause, Play, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Profile, type CatalogPage } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { notifyWarning } from '../lib/notifications';
import { Button } from './ui/button';
import { SelectField } from './settings-fields';
import { Badge } from './ui/badge';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/alert-dialog';

interface Item {
  id: string;
  message: string;
  kind: string;
  status: string;
  next_at?: string;
  wake_date?: string;
  scheduler_state?: string;
  condition?: { entity_id?: string; source?: string };
}
const statuses: Record<string, string> = {
  active: 'Activo',
  paused: 'Desactivado',
  cancelled: 'Eliminado',
  completed: 'Completado',
};
export function ProfileCatalogs({ profile, active }: { profile: Profile; active: boolean }) {
  const t = useTranslations();
  const { busy, run, setNotice } = useAdminTask();
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<CatalogPage<Item>>();
  const [missing, setMissing] = useState<Record<string, number>>({});
  const [uncertain, setUncertain] = useState<string[]>([]);
  const path =
    '/v1/admin/profiles/' + profile.bot + '/' + encodeURIComponent(profile.chatId) + '/rules';
  async function load(start = 0) {
    const result = await api<CatalogPage<Item>>(
      path +
        '?' +
        new URLSearchParams({
          ...(kind ? { kind } : {}),
          offset: String(start),
          limit: '20',
        }),
    );
    setMissing({});
    setPage(result);
    setUncertain([]);
    setOffset(start);
  }
  useEffect(() => {
    if (active) void run(() => load());
  }, [active, kind, path]);
  async function change(
    item: Item,
    operation: 'pause' | 'resume' | 'cancel' | 'confirm' | 'recreate',
  ) {
    let absentVersion: number | undefined;
    const version = missing[item.id];
    setMissing({});
    try {
      const result = await api<{ warning?: string; missing?: boolean; version?: number }>(
        path + '/' + encodeURIComponent(item.id),
        operation === 'cancel' ? 'DELETE' : 'PATCH',
        operation === 'cancel'
          ? undefined
          : { operation, ...(operation === 'recreate' ? { version } : {}) },
      );
      if (result.missing) absentVersion = result.version;
      else if (result.warning) {
        setUncertain((ids) => [...ids, item.id]);
        notifyWarning(result.warning);
      } else
        setNotice(operation === 'cancel' ? t('Elemento eliminado.') : t('Estado actualizado.'));
    } catch (error) {
      setUncertain((ids) => [...ids, item.id]);
      throw error;
    } finally {
      // Read the saved state; never replay a mutation with an uncertain result.
      await load(offset);
      if (absentVersion !== undefined) setMissing({ [item.id]: absentVersion });
    }
  }
  return (
    <section className="profile-notifications">
      <div className="notification-toolbar">
        <h3>{t('Alertas y recordatorios')}</h3>
        <div className="action-group">
          <SelectField
            id="profile-rule-kind"
            label={t('Mostrar')}
            value={kind}
            disabled={busy}
            onChange={(event) => {
              setKind(event.target.value);
              setPage(undefined);
              setOffset(0);
            }}
          >
            <option value="">{t('Todos')}</option>
            <option value="alert">{t('Alertas')}</option>
            <option value="reminder">{t('Recordatorios')}</option>
            <option value="timer">{t('Temporizadores')}</option>
          </SelectField>
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip={t('Recargar alertas y recordatorios')}
            disabled={busy}
            onClick={() => void run(() => load(offset))}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      {!page && (
        <p role="status">{busy ? t('Cargando…') : t('Recarga para consultar los elementos.')}</p>
      )}
      {page && (
        <>
          <div className="notification-list">
            {page.items.map((item) => {
              const locked =
                uncertain.includes(item.id) ||
                item.scheduler_state === 'uncertain' ||
                item.scheduler_state === 'installing';
              return (
                <article className="notification-row" key={item.id}>
                  <div className="notification-description">
                    <strong>{item.message || item.id}</strong>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{t(statuses[item.status] || item.status)}</Badge>
                      <small>
                        {item.next_at ||
                          item.wake_date ||
                          (item.condition?.source === 'weather'
                            ? t('Según el tiempo')
                            : item.condition?.entity_id || t('Según condición'))}
                      </small>
                    </div>
                    {locked && (
                      <p role="status" className="settings-help">
                        {t(
                          missing[item.id] !== undefined
                            ? 'Home Assistant no encuentra esta alerta. Puedes recrearla con confirmación.'
                            : 'Estado pendiente de confirmación en el planificador. No se reintentará el cambio automáticamente. Comprueba su estado para recuperar los controles.',
                        )}
                      </p>
                    )}
                  </div>
                  <div className="action-group">
                    {missing[item.id] !== undefined && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            disabled={busy}
                            tooltip={t('Recrear alerta')}
                          >
                            <RotateCcw />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('¿Recrear esta alerta?')}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {item.message}{' '}
                              {t(
                                'Home Assistant no encuentra esta alerta. Se conservarán su identificador, configuración y estado activo o desactivado. No se repetirán avisos anteriores.',
                              )}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => void run(() => change(item, 'recreate'))}
                            >
                              {t('Recrear alerta')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                    {locked && missing[item.id] === undefined && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        tooltip={t('Comprobar estado del planificador')}
                        disabled={busy}
                        onClick={() => void run(() => change(item, 'confirm'))}
                      >
                        <RefreshCw />
                      </Button>
                    )}
                    {['active', 'paused'].includes(item.status) && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            disabled={busy || locked}
                            tooltip={item.status === 'active' ? t('Desactivar') : t('Activar')}
                          >
                            {item.status === 'active' ? <Pause /> : <Play />}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {item.status === 'active'
                                ? t('¿Desactivar este elemento?')
                                : t('¿Activar este elemento?')}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {item.message} {t('· Se actualizará en su planificador actual.')}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() =>
                                void run(() =>
                                  change(item, item.status === 'active' ? 'pause' : 'resume'),
                                )
                              }
                            >
                              {t('Confirmar')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                    {item.status !== 'cancelled' && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            className="danger"
                            size="icon"
                            tooltip={t('Eliminar')}
                            disabled={busy}
                          >
                            <Trash2 />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('¿Eliminar este elemento?')}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {item.message}{' '}
                              {t(
                                '· Se cancelarán sus próximas notificaciones. Se conserva el historial.',
                              )}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={() => void run(() => change(item, 'cancel'))}
                            >
                              {t('Eliminar')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </article>
              );
            })}
            {!page.items.length && <p>{t('No hay elementos de este tipo en este perfil.')}</p>}
          </div>
          <div className="pager">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              tooltip={t('Anterior')}
              disabled={busy || !offset}
              onClick={() => void run(() => load(Math.max(0, offset - 20)))}
            >
              <ArrowLeft />
            </Button>
            <small>
              {page.total ? offset + 1 : 0}–{offset + page.items.length} {t('de')} {page.total}
            </small>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              tooltip={t('Siguiente')}
              disabled={busy || page.next_offset === null}
              onClick={() => void run(() => load(page.next_offset ?? offset + 20))}
            >
              <ArrowRight />
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
