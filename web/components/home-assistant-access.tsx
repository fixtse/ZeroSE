'use client';
import { useTranslations } from '../i18n/provider';

import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Pencil, RotateCw, Save, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Field } from './settings-fields';
import { SecretEditor } from './secret-editor';
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

interface Connection {
  id: string;
  name: string;
  url: string;
  tokenHint?: string;
  version: string;
}
interface Page {
  items: Connection[];
  total: number;
  next_offset: number | null;
}
const endpoint = '/v1/admin/home-assistant/connections';

export function HomeAssistantAccess() {
  const t = useTranslations();
  const [page, setPage] = useState<Page>();
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const { busy, run, setNotice } = useAdminTask();
  async function load(start = offset, query = search) {
    const next = await api<Page>(
      endpoint + '?' + new URLSearchParams({ offset: String(start), limit: '20', search: query }),
    );
    setPage(next);
    setOffset(start);
    setEditing(undefined);
    setToken('');
  }
  useEffect(() => {
    void run(() => load(0));
  }, []);
  return (
    <div className="space-y-4">
      <p>
        {t(
          'Servidores que puedes seleccionar en los perfiles. Cambiar el nombre o el token actualiza los perfiles que usan esa conexión.',
        )}
      </p>
      <div className="service-settings-heading">
        <Field
          id="ha-connections-search"
          label={t('Buscar servidor')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          tooltip={t('Buscar y recargar conexiones')}
          disabled={busy}
          onClick={() => void run(() => load(0))}
        >
          <RotateCw />
        </Button>
      </div>
      {!page && <p>{t('Cargando conexiones…')}</p>}
      {page?.items.length === 0 && (
        <p>
          {t(
            'No hay conexiones. Vincula la integración Zero desde Home Assistant o guarda una conexión manual desde un perfil.',
          )}
        </p>
      )}
      <div className="people-list">
        {page?.items.map((connection) => (
          <div className="ha-user-row" key={connection.id}>
            <div className="person-details min-w-0 break-words">
              {editing === connection.id ? (
                <>
                  <Field
                    id={'ha-name-' + connection.id}
                    label={t('Nombre de Home Assistant')}
                    value={name}
                    maxLength={100}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <p>{connection.url}</p>
                  <SecretEditor
                    id={'ha-token-' + connection.id}
                    label={t('Token de larga duración')}
                    value={token}
                    configured={!!connection.tokenHint}
                    hint={connection.tokenHint}
                    onChange={setToken}
                    disabled={busy}
                  />
                  <p>{t('Deja el token vacío para conservar el guardado.')}</p>
                </>
              ) : (
                <>
                  <strong>{connection.name}</strong>
                  <p>{connection.url}</p>
                  <p>
                    {t('Token de larga duración:')} {connection.tokenHint || t('Sin configurar')}
                  </p>
                </>
              )}
            </div>
            <div className="action-group shrink-0">
              {editing === connection.id ? (
                <>
                  <Button
                    type="button"
                    size="icon"
                    tooltip={t('Guardar conexión')}
                    disabled={busy || !name.trim()}
                    onClick={() =>
                      void run(async () => {
                        await api(endpoint, 'PUT', {
                          id: connection.id,
                          version: connection.version,
                          name,
                          token,
                        });
                        await load();
                        setNotice(t('Conexión actualizada.'));
                      })
                    }
                  >
                    <Save />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    tooltip={t('Cancelar edición')}
                    disabled={busy}
                    onClick={() => {
                      setEditing(undefined);
                      setToken('');
                    }}
                  >
                    <X />
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  tooltip={t('Editar ') + connection.name}
                  disabled={busy}
                  onClick={() => {
                    setEditing(connection.id);
                    setName(connection.name);
                    setToken('');
                  }}
                >
                  <Pencil />
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    tooltip={t('Eliminar ') + connection.name}
                    disabled={busy}
                  >
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('¿Eliminar')} {connection.name}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(
                        'Se eliminarán esta conexión y su token guardado de Zero y de los perfiles que la usan. Si un perfil tiene otro servidor seleccionado, pasará a usarlo. Los perfiles, su memoria y las reglas se conservan. Esto no revoca el token en Home Assistant.',
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() =>
                        void run(async () => {
                          await api(endpoint, 'DELETE', {
                            id: connection.id,
                            version: connection.version,
                          });
                          await load(
                            Math.max(0, offset - (page.items.length === 1 && offset > 0 ? 20 : 0)),
                          );
                          setNotice(t('Conexión eliminada.'));
                        })
                      }
                    >
                      {t('Eliminar conexión')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ))}
      </div>
      {page && page.total > 20 && (
        <div className="action-group">
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip={t('Conexiones anteriores')}
            disabled={busy || offset === 0}
            onClick={() => void run(() => load(Math.max(0, offset - 20)))}
          >
            <ArrowLeft />
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + 20, page.total)} {t('de')} {page.total}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            tooltip={t('Siguientes conexiones')}
            disabled={busy || page.next_offset === null}
            onClick={() => void run(() => load(offset + 20))}
          >
            <ArrowRight />
          </Button>
        </div>
      )}
    </div>
  );
}
