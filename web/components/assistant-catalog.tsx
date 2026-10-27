'use client';
import { notify as setNotice, notifyError } from '../lib/notifications';
import { useAdminApi } from '../hooks/use-admin-api';
import { ArrowLeft, ArrowRight, Pencil, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import { useUrlState } from '../hooks/use-url-state';
import { BotSettings } from './bot-settings';
import { AssistantAvatar, AssistantImageSettings } from './assistant-image';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { type AssistantDefinition, type AssistantSummary } from '../lib/api';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
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
const endpoint = '/v1/admin/setup/assistants';
export function AssistantCatalog({ onZeroChanged }: { onZeroChanged: () => Promise<void> }) {
  const api = useAdminApi();
  const [items, setItems] = useState<AssistantSummary[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [query, setQuery] = useState('');
  const [editor, setEditor] = useState<AssistantDefinition | null>(),
    [busy, setBusy] = useState(false);
  const [assistantRoute, setAssistantRoute] = useUrlState('assistant', 'zero');
  const [usage, setUsage] = useState<{
    items: { bot: string; chatId: string; label: string }[];
    total: number;
  }>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const running = useRef(false);
  async function loadUsage(id: string, offset = 0) {
    const page = await api<NonNullable<typeof usage>>(
      endpoint + '/' + id + '/users?limit=20&offset=' + offset,
    );
    setUsage((old) => ({
      ...page,
      items: offset ? [...(old?.items || []), ...page.items] : page.items,
    }));
  }
  async function list(search = query, start = offset) {
    const value = await api<{ items: AssistantSummary[]; total: number }>(
      endpoint + '?limit=20&offset=' + start + '&search=' + encodeURIComponent(search),
    );
    setItems(value.items);
    setTotal(value.total);
    setOffset(start);
  }
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      notifyError(error instanceof Error ? error.message : 'No se pudo completar la operación.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(async () => {
      await list('', 0);
      // The selected assistant is loaded from the URL below.
    });
  }, []);
  useEffect(() => {
    let active = true;
    if (assistantRoute === 'new') setEditor(null);
    else
      void api<AssistantDefinition>(endpoint + '/' + encodeURIComponent(assistantRoute))
        .then((value) => {
          if (active) setEditor(value);
        })
        .catch((error) => {
          if (active) notifyError(error);
        });
    return () => {
      active = false;
    };
  }, [assistantRoute]);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      const value = await api<AssistantDefinition>(
        editor ? endpoint + '/' + editor.id : endpoint,
        editor ? 'PUT' : 'POST',
        {
          name: data.get('name'),
          prompt: data.get('prompt'),
          ...(editor ? { revision: editor.revision } : {}),
        },
      );
      setEditor(value);
      setAssistantRoute(value.id);
      if (value.id === 'zero') await onZeroChanged();
      await list();
      setNotice('Asistente guardado. Se aplicará a las próximas solicitudes.');
    });
  }
  return (
    <div className="assistant-workspace">
      <div className="page-heading">
        <div>
          <div className="eyebrow">TUS ASISTENTES</div>
          <h1>Tus asistentes.</h1>
          <p>
            Crea asistentes con sus propias instrucciones y asígnalos a los usuarios que los
            necesitan.
          </p>
        </div>
        <Button
          size="icon"
          tooltip="Nuevo asistente"
          disabled={busy}
          onClick={() => {
            setAssistantRoute('new');
          }}
        >
          <Plus />
        </Button>
      </div>
      <div className="assistant-columns">
        <Card className="panel assistant-list">
          <form
            className="search-row"
            onSubmit={(event) => {
              event.preventDefault();
              const search = String(new FormData(event.currentTarget).get('search') || '');
              setQuery(search);
              void run(() => list(search, 0));
            }}
          >
            <Input
              name="search"
              aria-label="Buscar asistentes"
              placeholder="Buscar asistentes…"
              maxLength={100}
            />
            <Button variant="outline" size="icon" tooltip="Buscar" disabled={busy}>
              <Search />
            </Button>
          </form>
          {items.map((item) => (
            <Button
              variant="ghost"
              className={'assistant-option ' + (editor?.id === item.id ? 'selected' : '')}
              key={item.id}
              disabled={busy}
              onClick={() => setAssistantRoute(item.id)}
            >
              <span className="assistant-avatar">
                <AssistantAvatar id={item.id} />
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>{item.builtin ? 'Asistente integrado' : 'Personalizado'}</small>
              </span>
              <Pencil size={14} />
            </Button>
          ))}
          {!items.length && <p>No hay asistentes con esta búsqueda.</p>}
          <div className="pager">
            <Button
              variant="ghost"
              disabled={busy || !offset}
              onClick={() => void run(() => list(query, Math.max(0, offset - 20)))}
              size="icon"
              tooltip="←"
            >
              <ArrowLeft />
            </Button>
            <small>{total} asistentes</small>
            <Button
              variant="ghost"
              disabled={busy || offset + 20 >= total}
              onClick={() => void run(() => list(query, offset + 20))}
              size="icon"
              tooltip="→"
            >
              <ArrowRight />
            </Button>
          </div>
          <small>
            Los perfiles existentes mantienen su asistente hasta que cambies la asignación.
          </small>
        </Card>
        <Card className="panel assistant-editor-panel">
          {editor === undefined ? (
            <p>Cargando asistente…</p>
          ) : (
            <>
              <form onSubmit={save} key={editor ? editor.id + ':' + editor.revision : 'new'}>
                <div className="assistant-editor-heading">
                  <h2>{editor ? 'Editar asistente' : 'Un nuevo asistente'}</h2>
                  {editor?.builtin && <Badge variant="outline">Integrado</Badge>}
                  <div
                    className="editor-heading-actions"
                    role="group"
                    aria-label="Acciones del asistente"
                  >
                    <Button
                      disabled={busy}
                      size="icon"
                      tooltip={editor ? 'Guardar asistente' : 'Crear asistente'}
                    >
                      <Save />
                    </Button>
                    {editor && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => setEditor(await api(endpoint + '/' + editor.id)))
                        }
                        size="icon"
                        tooltip="Recargar"
                      >
                        <RefreshCw />
                      </Button>
                    )}
                    {editor && !editor.builtin && (
                      <AlertDialog
                        open={deleteOpen}
                        onOpenChange={(open) => {
                          setDeleteOpen(open);
                          if (open) {
                            setUsage(undefined);
                            void run(() => loadUsage(editor.id));
                          }
                        }}
                      >
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            className="danger"
                            disabled={busy}
                            size="icon"
                            tooltip="Eliminar"
                          >
                            <Trash2 />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>¿Eliminar {editor.name}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Los perfiles que lo utilizan pasarán a Zero. Se conservan sus
                              permisos, conexiones e historiales. Desconecta primero el bot de
                              Telegram si tiene uno.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          {usage ? (
                            <div>
                              <p>
                                {usage.total
                                  ? usage.total + ' perfiles utilizan este asistente:'
                                  : 'Ningún perfil utiliza este asistente.'}
                              </p>
                              <ul className="assistant-usage-list">
                                {usage.items.map((profile) => (
                                  <li key={profile.bot + ':' + profile.chatId}>
                                    {profile.label} · {profile.bot} · {profile.chatId}
                                  </li>
                                ))}
                              </ul>
                              {usage.items.length < usage.total && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    void run(() => loadUsage(editor.id, usage.items.length))
                                  }
                                >
                                  Ver más perfiles
                                </Button>
                              )}
                            </div>
                          ) : (
                            <p role="status">
                              {busy
                                ? 'Cargando perfiles…'
                                : 'No se pudieron cargar los perfiles. Cierra y vuelve a intentarlo.'}
                            </p>
                          )}
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              disabled={busy || !usage}
                              onClick={() =>
                                void run(async () => {
                                  await api(endpoint + '/' + editor.id, 'DELETE', {
                                    revision: editor.revision,
                                  });
                                  setAssistantRoute('zero');
                                  await list(query, 0);
                                  setNotice('Asistente eliminado.');
                                })
                              }
                            >
                              Eliminar asistente
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </div>
                {editor && (
                  <AssistantImageSettings key={editor.id} id={editor.id} name={editor.name} />
                )}
                <Label htmlFor="assistant-name">Nombre</Label>
                <Input
                  id="assistant-name"
                  name="name"
                  defaultValue={editor?.name || ''}
                  required
                  maxLength={100}
                  readOnly={editor?.id === 'zero'}
                />
                <Label htmlFor="assistant-prompt">Prompt e instrucciones</Label>
                <Textarea
                  id="assistant-prompt"
                  name="prompt"
                  defaultValue={editor?.prompt || ''}
                  rows={16}
                  required
                  maxLength={100000}
                  placeholder="Eres un asistente especializado en… Define su personalidad, su objetivo y cómo debe responder."
                />
                <small>
                  Puedes usar {'{{name}}'}, {'{{now}}'}, {'{{timezone}}'}, {'{{identity}}'} y{' '}
                  {'{{context}}'}. El contexto es el texto editable del usuario o grupo, disponible
                  con la memoria activada, sin Google. Cada usuario conserva sus permisos, memoria e
                  historial.{' '}
                  {editor?.id === 'zero' &&
                    'Este es el mismo prompt de Zero que se edita desde Home Assistant.'}
                </small>
                <p className="assistant-assignment-hint">
                  Para asociarlo a un usuario, abre Usuarios → Asistente. Un asistente puede
                  utilizarse en varios perfiles.
                </p>
              </form>
              {editor && <BotSettings key={editor.id} id={editor.id} name={editor.name} />}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
