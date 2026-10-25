'use client';
import { useEffect, useRef, useState } from 'react';
import { Bot, Search } from 'lucide-react';
import { api, type Profile, type AssistantSummary } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from './ui/dialog';
export function AssistantAssignment({
  profile,
  onAssigned,
}: {
  profile: Profile;
  onAssigned: () => Promise<void>;
}) {
  const endpoint = '/v1/admin/setup/profiles/' + profile.bot + '/' + profile.chatId + '/assistant';
  const [current, setCurrent] = useState<AssistantSummary>(),
    [open, setOpen] = useState(false),
    [items, setItems] = useState<AssistantSummary[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [query, setQuery] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice('');
    try {
      await work();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'No se pudo guardar la asignación.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function list(search = query, start = offset) {
    const result = await api<{ items: AssistantSummary[]; total: number }>(
      '/v1/admin/setup/assistants?limit=20&offset=' +
        start +
        '&search=' +
        encodeURIComponent(search),
    );
    setItems(result.items);
    setTotal(result.total);
    setOffset(start);
  }
  useEffect(() => {
    let active = true;
    api<AssistantSummary>(endpoint)
      .then((value) => {
        if (active) setCurrent(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [endpoint, profile.assistantId]);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (busy) return;
        setOpen(value);
        if (value) void run(() => list('', 0));
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="assistant-assignment">
          <Bot />
          {current?.name || 'Elegir asistente'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Asistente de {profile.label}</DialogTitle>
          <DialogDescription>
            Elige qué personalidad e instrucciones usará este perfil. Sus permisos, memoria e
            historial se conservan. También se aplica al usuario de Home Assistant vinculado a este
            perfil.
          </DialogDescription>
        </DialogHeader>
        {notice && (
          <p role="alert" className="notice">
            {notice}
          </p>
        )}
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
            aria-label="Buscar asistente para asignar"
            placeholder="Buscar asistentes…"
            maxLength={100}
          />
          <Button size="icon" variant="outline" aria-label="Buscar" disabled={busy}>
            <Search />
          </Button>
        </form>
        <div className="assignment-options">
          {items.map((item) => (
            <Button
              variant={current?.id === item.id ? 'secondary' : 'ghost'}
              className="assistant-option"
              key={item.id}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(endpoint, 'PUT', { assistantId: item.id });
                  setCurrent(item);
                  await onAssigned();
                  setOpen(false);
                })
              }
            >
              <Bot size={18} />
              <span>{item.name}</span>
              {current?.id === item.id && <small>Actual</small>}
            </Button>
          ))}
          {!items.length && <p>No hay asistentes con esta búsqueda.</p>}
        </div>
        <div className="pager">
          <Button
            variant="ghost"
            disabled={busy || !offset}
            onClick={() => void run(() => list(query, Math.max(0, offset - 20)))}
          >
            ← Anterior
          </Button>
          <small>{total} asistentes</small>
          <Button
            variant="ghost"
            disabled={busy || offset + 20 >= total}
            onClick={() => void run(() => list(query, offset + 20))}
          >
            Siguiente →
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
