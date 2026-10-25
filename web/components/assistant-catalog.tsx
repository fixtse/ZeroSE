'use client';
import { AssistantAvatar, AssistantImageSettings } from './assistant-image';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Pencil, Search } from 'lucide-react';
import { api, type AssistantDefinition, type AssistantSummary } from '../lib/api';
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
  const [items, setItems] = useState<AssistantSummary[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [query, setQuery] = useState('');
  const [editor, setEditor] = useState<AssistantDefinition | null>(),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const running = useRef(false);
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
    setNotice('');
    try {
      await work();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'No se pudo completar la operación.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(async () => {
      await list('', 0);
      setEditor(await api(endpoint + '/zero'));
    });
  }, []);
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
          <h1>
            Distintas personalidades.
            <br />
            Tu mismo espacio.
          </h1>
          <p>
            Crea asistentes con sus propias instrucciones y asígnalos a las personas que los
            necesitan.
          </p>
        </div>
        <Button
          disabled={busy}
          onClick={() => {
            setEditor(null);
            setNotice('');
          }}
        >
          <Plus /> Nuevo asistente
        </Button>
      </div>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
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
            <Button variant="outline" size="icon" aria-label="Buscar" disabled={busy}>
              <Search />
            </Button>
          </form>
          {items.map((item) => (
            <Button
              variant="ghost"
              className={'assistant-option ' + (editor?.id === item.id ? 'selected' : '')}
              key={item.id}
              disabled={busy}
              onClick={() => void run(async () => setEditor(await api(endpoint + '/' + item.id)))}
            >
              <span className="assistant-avatar">
                <AssistantAvatar id={item.id} />
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.id === 'salem'
                    ? 'Importado de Salem'
                    : item.builtin
                      ? 'Asistente integrado'
                      : 'Personalizado'}
                </small>
              </span>
              <Pencil size={14} />
            </Button>
          ))}
          {!items.length && <p>No hay asistentes con esta búsqueda.</p>}
          <div className="pager">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !offset}
              onClick={() => void run(() => list(query, Math.max(0, offset - 20)))}
            >
              ←
            </Button>
            <small>{total} asistentes</small>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || offset + 20 >= total}
              onClick={() => void run(() => list(query, offset + 20))}
            >
              →
            </Button>
          </div>
          <small>
            Salem conserva su prompt original. Los perfiles existentes mantienen su asistente hasta
            que cambies la asignación.
          </small>
        </Card>
        <Card className="panel">
          {editor === undefined ? (
            <p>Cargando asistente…</p>
          ) : (
            <form onSubmit={save} key={editor ? editor.id + ':' + editor.revision : 'new'}>
              <div className="assistant-editor-heading">
                <h2>{editor ? 'Editar asistente' : 'Un nuevo asistente'}</h2>
                {editor?.builtin && <Badge variant="outline">Integrado</Badge>}
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
                Puedes usar {'{{name}}'}, {'{{now}}'}, {'{{timezone}}'} y {'{{identity}}'}. Cada
                persona conserva sus permisos, memoria e historial.{' '}
                {editor?.id === 'zero' &&
                  'Este es el mismo prompt de Zero que se edita desde Home Assistant.'}
              </small>
              <div className="form-actions">
                <Button disabled={busy}>{editor ? 'Guardar asistente' : 'Crear asistente'}</Button>
                {editor && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => setEditor(await api(endpoint + '/' + editor.id)))
                    }
                  >
                    Recargar
                  </Button>
                )}
                {editor && !editor.builtin && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" variant="ghost" className="danger" disabled={busy}>
                        Eliminar
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>¿Eliminar {editor.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Solo se puede eliminar si ningún perfil tiene este asistente asignado. Los
                          historiales de conversación se conservan.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() =>
                            void run(async () => {
                              await api(endpoint + '/' + editor.id, 'DELETE', {
                                revision: editor.revision,
                              });
                              setEditor(null);
                              await list();
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
              <p className="assistant-assignment-hint">
                Para asociarlo a una persona, abre Personas → Asistente. Un asistente puede
                utilizarse en varios perfiles.
              </p>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
