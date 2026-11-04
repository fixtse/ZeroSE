'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Pencil, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import { api, type Profile, type CatalogPage } from '../lib/api';
import { useUrlState } from '../hooks/use-url-state';
import { notifyError } from '../lib/notifications';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { HAEntityPicker } from './ha-entity-picker';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Field } from './settings-fields';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/alert-dialog';
interface Member {
  userId: string;
  name: string;
  username: string;
  present: boolean;
  observed: boolean;
  locationEntity: string;
  geocodedLocationEntity: string;
}
const empty: Member = {
  userId: '',
  name: '',
  username: '',
  present: true,
  observed: false,
  locationEntity: '',
  geocodedLocationEntity: '',
};
export function GroupMembers({ profile, active }: { profile: Profile; active: boolean }) {
  const { busy, run, setNotice } = useAdminTask();
  const [selected, setSelected] = useUrlState('member', '');
  const [page, setPage] = useState<CatalogPage<Member>>();
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Member>();
  const [original, setOriginal] = useState<Member>();
  const [confirm, setConfirm] = useState<'save' | 'delete'>();
  const base = '/v1/admin/profiles/' + profile.bot + '/' + profile.chatId + '/members';
  async function load(start = offset) {
    setPage(
      await api(base + '?' + new URLSearchParams({ search, offset: String(start), limit: '20' })),
    );
    setOffset(start);
  }
  useEffect(() => {
    if (active) void run(() => load(0));
  }, [active, base]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setEditing(undefined);
    setOriginal(undefined);
    if (selected === 'new') setEditing({ ...empty });
    else if (selected)
      void api<Member>(base + '/' + encodeURIComponent(selected))
        .then((value) => {
          if (!cancelled) {
            setEditing(value);
            setOriginal(value);
          }
        })
        .catch((error) => {
          if (!cancelled) notifyError(error);
        });
    return () => {
      cancelled = true;
    };
  }, [active, selected, base]);
  const valid =
    !!editing &&
    /^[1-9]\d{0,15}$/.test(editing.userId) &&
    Number.isSafeInteger(Number(editing.userId)) &&
    !!editing.name.trim() &&
    /^(?:(?:person|device_tracker)\.[a-z0-9_]+)?$/.test(editing.locationEntity) &&
    /^(?:sensor\.[a-z0-9_]+)?$/.test(editing.geocodedLocationEntity);
  async function save(confirmLocationExposure = false) {
    if (!editing || !valid) return;
    const result = await api<{ confirmationRequired?: string[] }>(
      selected === 'new' ? base : base + '/' + editing.userId,
      selected === 'new' ? 'POST' : 'PUT',
      {
        ...(selected === 'new' ? { userId: editing.userId } : {}),
        name: editing.name.trim(),
        confirmLocationExposure,
        locationEntity: editing.locationEntity.trim(),
        geocodedLocationEntity: editing.geocodedLocationEntity.trim(),
      },
    );
    if (result.confirmationRequired?.length) {
      setConfirm('save');
      return;
    }
    const saved = await api<Member>(base + '/' + editing.userId);
    setEditing(saved);
    setOriginal(saved);
    setSelected('');
    setEditing(undefined);
    await load();
    setNotice('Integrante guardado.');
  }
  function requestSave() {
    if (
      editing &&
      (editing.locationEntity || editing.geocodedLocationEntity) &&
      (editing.locationEntity !== original?.locationEntity ||
        editing.geocodedLocationEntity !== original?.geocodedLocationEntity)
    )
      setConfirm('save');
    else void run(() => save());
  }
  const update = (key: keyof Member, value: string) =>
    setEditing((current) => (current ? { ...current, [key]: value } : current));
  return (
    <section className="settings-section">
      <h3 className="settings-heading">Integrantes del grupo</h3>
      <p>
        Telegram no proporciona la lista completa. Aquí aparecen las personas detectadas en mensajes
        y avisos de entrada o salida, y las que añadas por ID. Esto no habilita su perfil privado.
      </p>
      <div className="member-search-toolbar">
        <Field
          id="member-search"
          label="Buscar integrante"
          value={search}
          maxLength={200}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          tooltip="Buscar integrantes"
          disabled={busy}
          onClick={() => void run(() => load(0))}
        >
          <Search />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          tooltip="Recargar integrantes"
          disabled={busy}
          onClick={() => void run(() => load())}
        >
          <RefreshCw />
        </Button>
        <Button
          type="button"
          size="icon"
          tooltip="Añadir integrante por ID"
          disabled={busy}
          onClick={() => setSelected('new')}
        >
          <Plus />
        </Button>
      </div>
      {page?.items.map((item) => (
        <div className="profile-row" key={item.userId}>
          <div>
            <strong>{item.name}</strong>
            <small>
              {item.username ? '@' + item.username + ' · ' : ''}
              {item.userId} ·{' '}
              {item.observed
                ? item.present
                  ? 'Detectado'
                  : 'Salió del grupo'
                : 'Añadido manualmente'}
            </small>
            <small>
              {item.locationEntity || item.geocodedLocationEntity
                ? 'Ubicación asignada'
                : 'Sin ubicación asignada'}
            </small>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip={'Editar a ' + item.name}
            disabled={busy}
            onClick={() => setSelected(item.userId)}
          >
            <Pencil />
          </Button>
        </div>
      ))}
      {page && !page.items.length && (
        <p>No hay integrantes que mostrar. Puedes añadirlos por su ID de Telegram.</p>
      )}
      {page && (
        <div className="member-pagination" role="group" aria-label="Paginación de integrantes">
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip="Integrantes anteriores"
            disabled={busy || offset === 0}
            onClick={() => void run(() => load(Math.max(0, offset - 20)))}
          >
            <ArrowLeft />
          </Button>
          <span>{page.total} integrantes</span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip="Integrantes siguientes"
            disabled={busy || offset + 20 >= page.total}
            onClick={() => void run(() => load(offset + 20))}
          >
            <ArrowRight />
          </Button>
        </div>
      )}
      {editing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setSelected('');
          }}
        >
          <DialogContent className="member-editor">
            <DialogHeader>
              <DialogTitle>{selected === 'new' ? 'Añadir integrante' : editing.name}</DialogTitle>
              <DialogDescription>Datos y entidades de este integrante del grupo.</DialogDescription>
            </DialogHeader>
            <div className="settings-grid">
              <Field
                id="member-user-id"
                label="ID de usuario de Telegram"
                value={editing.userId}
                readOnly={selected !== 'new'}
                inputMode="numeric"
                maxLength={16}
                onChange={(event) => update('userId', event.target.value)}
              />
              {selected === 'new' ? (
                <Field
                  id="member-name"
                  label="Nombre del integrante"
                  value={editing.name}
                  maxLength={100}
                  onChange={(event) => update('name', event.target.value)}
                />
              ) : (
                <p>Nombre: {editing.name}</p>
              )}
              {profile.hasHomeAssistant && (
                <>
                  <HAEntityPicker
                    profile={profile}
                    assignment
                    id="member-location"
                    label="Entidad de ubicación del integrante"
                    domains="person,device_tracker"
                    value={editing.locationEntity}
                    onChange={(value) => update('locationEntity', value)}
                  />
                  <HAEntityPicker
                    profile={profile}
                    assignment
                    id="member-address"
                    label="Entidad de dirección del integrante"
                    domains="sensor"
                    value={editing.geocodedLocationEntity}
                    onChange={(value) => update('geocodedLocationEntity', value)}
                  />
                </>
              )}
            </div>
            <p className="settings-help">
              {profile.hasHomeAssistant
                ? 'La ubicación asignada podrá consultarse desde este grupo cuando Home Assistant esté permitido. Usa person.* o device_tracker.* para ubicación y sensor.* para dirección.'
                : 'Guarda primero una conexión en Home Assistant para asignar entidades.'}{' '}
              Guarda los integrantes con su propio botón; el botón del perfil guarda sus permisos y
              conexiones.
            </p>
            <div className="form-actions">
              <Button
                type="button"
                size="icon"
                tooltip="Guardar integrante"
                disabled={busy || !valid}
                onClick={requestSave}
              >
                <Save />
              </Button>
              {original && (
                <Button
                  type="button"
                  size="icon"
                  variant="destructive"
                  tooltip="Eliminar integrante"
                  disabled={busy}
                  onClick={() => setConfirm('delete')}
                >
                  <Trash2 />
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
      <AlertDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'delete'
                ? '¿Eliminar integrante?'
                : '¿Asignar ubicación a este integrante?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'delete'
                ? 'Se eliminarán sus asignaciones en este grupo. Puede volver a aparecer cuando Telegram envíe un nuevo mensaje suyo.'
                : 'Los integrantes del grupo podrán consultar esta ubicación mediante Zero si el grupo tiene permiso Home Assistant. Si no están expuestas a Assist, Zero las añadirá para toda la instancia de Home Assistant. Quitar esta asignación no las ocultará. Comprueba que pertenecen a la persona indicada.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm === 'delete' ? 'destructive' : 'default'}
              onClick={() => {
                const action = confirm;
                setConfirm(undefined);
                void run(async () => {
                  if (action === 'save') await save(true);
                  else if (editing) {
                    await api(base + '/' + editing.userId, 'DELETE');
                    setSelected('');
                    setEditing(undefined);
                    await load(0);
                  }
                });
              }}
            >
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
