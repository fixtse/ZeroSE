'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Pencil, RotateCw, Save, Trash2, X } from 'lucide-react';
import { api, type Settings } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { adminPath } from '../lib/admin-path';
import { Button } from './ui/button';
import { Field } from './settings-fields';
import { HomeAssistantUsers } from './home-assistant-users';
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

interface Access {
  id: string;
  name: string;
  scopes: ('voice' | 'settings' | 'rules')[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
interface Page {
  items: Access[];
  total: number;
}
const endpoint = '/v1/admin/setup/tokens';

export function HomeAssistantAccess() {
  const [page, setPage] = useState<Page>();
  const [offset, setOffset] = useState(0);
  const [settings, setSettings] = useState<Settings>();
  const [editing, setEditing] = useState<Access>();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('');
  const { busy, run, setNotice } = useAdminTask();
  async function load(start = offset) {
    const [next, bindings] = await Promise.all([
      api<Page>(endpoint + '?offset=' + start + '&limit=20'),
      api<Settings>('/v1/admin/setup/settings'),
    ]);
    setPage(next);
    setSettings(bindings);
    setOffset(start);
    setEditing(undefined);
  }
  useEffect(() => {
    void run(() => load(0));
  }, []);
  const date = (value: string) => new Date(value).toLocaleString();
  return (
    <div className="space-y-4">
      <div className="service-settings-heading">
        <p>
          Accesos creados por la integración. Revocar un acceso impide que siga conectándose a Zero.
        </p>
        <Button
          type="button"
          variant="outline"
          size="icon"
          tooltip="Recargar accesos"
          disabled={busy}
          onClick={() => void run(() => load())}
        >
          <RotateCw />
        </Button>
      </div>
      {!page && <p>Cargando accesos…</p>}
      {page?.items.length === 0 && (
        <p>No hay accesos. Añade la integración Zero desde Home Assistant y aprueba su conexión.</p>
      )}
      <div className="people-list">
        {page?.items.map((access) => {
          const revoked = !!access.revokedAt;
          const expired = Date.parse(access.expiresAt) <= Date.now();
          return (
            <div className="ha-user-row" key={access.id}>
              <div className="person-details min-w-0 break-words">
                {editing?.id === access.id ? (
                  <>
                    <Field
                      id={'ha-name-' + access.id}
                      label="Nombre del acceso"
                      value={name}
                      maxLength={100}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <Field
                      id={'ha-expiry-' + access.id}
                      label="Caducidad"
                      type="datetime-local"
                      value={expiry}
                      onChange={(event) => setExpiry(event.target.value)}
                    />
                  </>
                ) : (
                  <>
                    <strong>{access.name}</strong>
                    <p>
                      {revoked
                        ? 'Revocado · ' + date(access.revokedAt!)
                        : expired
                          ? 'Caducado'
                          : 'Activo'}{' '}
                      · Caducidad: {date(access.expiresAt)}
                    </p>
                    <p>Creado: {date(access.createdAt)} · Voz, ajustes y reglas</p>
                  </>
                )}
              </div>
              <div className="action-group shrink-0">
                {editing?.id === access.id ? (
                  <>
                    <Button
                      type="button"
                      size="icon"
                      tooltip="Guardar acceso"
                      disabled={busy || !name.trim() || !expiry}
                      onClick={() =>
                        void run(async () => {
                          await api(endpoint + '/' + access.id, 'PUT', {
                            expected: access,
                            name,
                            expiresAt: new Date(expiry).toISOString(),
                          });
                          await load();
                          setNotice('Acceso actualizado.');
                        })
                      }
                    >
                      <Save />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      tooltip="Cancelar edición"
                      disabled={busy}
                      onClick={() => setEditing(undefined)}
                    >
                      <X />
                    </Button>
                  </>
                ) : (
                  !revoked && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      tooltip={'Editar ' + access.name}
                      disabled={busy}
                      onClick={() => {
                        setEditing(access);
                        setName(access.name);
                        const local = new Date(access.expiresAt);
                        local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
                        setExpiry(local.toISOString().slice(0, 16));
                      }}
                    >
                      <Pencil />
                    </Button>
                  )
                )}
                {!revoked && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        tooltip={'Revocar ' + access.name}
                        disabled={busy}
                      >
                        <Trash2 />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>¿Revocar {access.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          La integración perderá el acceso a voz, ajustes y reglas de Zero. Tendrás
                          que vincularla de nuevo para recuperar el acceso. Las reglas y los
                          perfiles guardados se conservan.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          onClick={() =>
                            void run(async () => {
                              await api(endpoint + '/' + access.id, 'DELETE');
                              await load();
                              setNotice('Acceso revocado.');
                            })
                          }
                        >
                          Revocar acceso
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {page && page.total > 20 && (
        <div className="action-group">
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip="Accesos anteriores"
            disabled={busy || offset === 0}
            onClick={() => void run(() => load(Math.max(0, offset - 20)))}
          >
            <ArrowLeft />
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + 20, page.total)} de {page.total}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip="Siguientes accesos"
            disabled={busy || offset + 20 >= page.total}
            onClick={() => void run(() => load(offset + 20))}
          >
            <ArrowRight />
          </Button>
        </div>
      )}
      {settings && (
        <HomeAssistantUsers
          settings={settings}
          busy={busy}
          onEdit={(route) => {
            window.location.assign(
              adminPath('/admin/?' + new URLSearchParams({ page: 'people', profile: route })),
            );
          }}
          onUnlink={(userId) =>
            void run(async () => {
              await api('/v1/admin/setup/users', 'PUT', {
                revision: settings.revision,
                userId,
                chatId: null,
              });
              await load();
              setNotice('Usuario desvinculado.');
            })
          }
        />
      )}
    </div>
  );
}
