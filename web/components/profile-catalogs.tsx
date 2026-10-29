'use client';
import { ArrowLeft, ArrowRight, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
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
  const { busy, run, setNotice } = useAdminTask();
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<CatalogPage<Item>>();
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
    setPage(result);
    setOffset(start);
  }
  useEffect(() => {
    if (active) void run(() => load());
  }, [active, kind, path]);
  async function change(item: Item, operation: 'pause' | 'resume' | 'cancel') {
    try {
      const result = await api<{ warning?: string }>(
        path + '/' + encodeURIComponent(item.id),
        operation === 'cancel' ? 'DELETE' : 'PATCH',
        operation === 'cancel' ? undefined : { operation },
      );
      if (result.warning) {
        setUncertain((ids) => [...ids, item.id]);
        notifyWarning(result.warning);
      } else setNotice(operation === 'cancel' ? 'Elemento eliminado.' : 'Estado actualizado.');
    } catch (error) {
      setUncertain((ids) => [...ids, item.id]);
      throw error;
    } finally {
      // Read the saved state; never replay a mutation with an uncertain result.
      await load(offset);
    }
  }
  return (
    <section className="profile-notifications">
      <div className="notification-toolbar">
        <h3>Alertas y recordatorios</h3>
        <div className="action-group">
          <SelectField
            id="profile-rule-kind"
            label="Mostrar"
            value={kind}
            disabled={busy}
            onChange={(event) => {
              setKind(event.target.value);
              setPage(undefined);
              setOffset(0);
            }}
          >
            <option value="">Todos</option>
            <option value="alert">Alertas</option>
            <option value="reminder">Recordatorios</option>
            <option value="timer">Temporizadores</option>
          </SelectField>
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip="Recargar alertas y recordatorios"
            disabled={busy}
            onClick={() => void run(() => load(offset))}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      {!page && <p role="status">{busy ? 'Cargando…' : 'Recarga para consultar los elementos.'}</p>}
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
                      <Badge variant="secondary">{statuses[item.status] || item.status}</Badge>
                      <small>
                        {item.next_at ||
                          item.wake_date ||
                          (item.condition?.source === 'weather'
                            ? 'Según el tiempo'
                            : item.condition?.entity_id || 'Según condición')}
                      </small>
                    </div>
                    {locked && (
                      <p role="status" className="settings-help">
                        Estado pendiente de confirmación en el planificador. No se reintentará el
                        cambio automáticamente. Puedes eliminar el elemento.
                      </p>
                    )}
                  </div>
                  <div className="action-group">
                    {['active', 'paused'].includes(item.status) && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            disabled={busy || locked}
                            tooltip={item.status === 'active' ? 'Desactivar' : 'Activar'}
                          >
                            {item.status === 'active' ? <Pause /> : <Play />}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {item.status === 'active'
                                ? '¿Desactivar este elemento?'
                                : '¿Activar este elemento?'}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {item.message} · Se actualizará en su planificador actual.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() =>
                                void run(() =>
                                  change(item, item.status === 'active' ? 'pause' : 'resume'),
                                )
                              }
                            >
                              Confirmar
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
                            tooltip="Eliminar"
                            disabled={busy}
                          >
                            <Trash2 />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>¿Eliminar este elemento?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {item.message} · Se cancelarán sus próximas notificaciones. Se
                              conserva el historial.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={() => void run(() => change(item, 'cancel'))}
                            >
                              Eliminar
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </article>
              );
            })}
            {!page.items.length && <p>No hay elementos de este tipo en este perfil.</p>}
          </div>
          <div className="pager">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              tooltip="Anterior"
              disabled={busy || !offset}
              onClick={() => void run(() => load(Math.max(0, offset - 20)))}
            >
              <ArrowLeft />
            </Button>
            <small>
              {page.total ? offset + 1 : 0}–{offset + page.items.length} de {page.total}
            </small>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              tooltip="Siguiente"
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
