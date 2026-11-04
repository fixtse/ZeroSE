'use client';
import { useTranslations } from '../i18n/provider';
import { notifyError } from '../lib/notifications';
import { ArrowLeft, ArrowRight, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type Profile, type AssistantSummary } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { AssistantAvatar } from './assistant-image';
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
  const t = useTranslations();
  const endpoint = '/v1/admin/setup/profiles/' + profile.bot + '/' + profile.chatId + '/assistant';
  const [current, setCurrent] = useState<AssistantSummary>(),
    [open, setOpen] = useState(false),
    [items, setItems] = useState<AssistantSummary[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      notifyError(error instanceof Error ? error.message : t('No se pudo guardar la asignación.'));
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
        <Button variant="outline" tooltip={t('Cambiar asistente')} className="assistant-assignment">
          <span className="assistant-avatar assignment-avatar">
            <AssistantAvatar
              key={current?.id || profile.assistantId || profile.bot}
              id={current?.id || profile.assistantId || profile.bot}
            />
          </span>
          <span>{current?.name || t('Elegir asistente')}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('Asistente de')} {profile.label}
          </DialogTitle>
          <DialogDescription>
            {t(
              'Elige qué personalidad e instrucciones usará este perfil. Sus permisos, memoria e historial se conservan. También se aplica al usuario de Home Assistant vinculado a este perfil.',
            )}
          </DialogDescription>
        </DialogHeader>
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
            aria-label={t('Buscar asistente para asignar')}
            placeholder={t('Buscar asistentes…')}
            maxLength={100}
          />
          <Button size="icon" variant="outline" tooltip={t('Buscar')} disabled={busy}>
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
              <span className="assistant-avatar">
                <AssistantAvatar key={item.id} id={item.id} />
              </span>
              <span>{item.name}</span>
              {current?.id === item.id && <small>{t('Actual')}</small>}
            </Button>
          ))}
          {!items.length && <p>{t('No hay asistentes con esta búsqueda.')}</p>}
        </div>
        <div className="pager">
          <Button
            variant="ghost"
            disabled={busy || !offset}
            onClick={() => void run(() => list(query, Math.max(0, offset - 20)))}
            size="icon"
            tooltip={t('← Anterior')}
          >
            <ArrowLeft />
          </Button>
          <small>
            {total} {t('asistentes')}
          </small>
          <Button
            variant="ghost"
            disabled={busy || offset + 20 >= total}
            onClick={() => void run(() => list(query, offset + 20))}
            size="icon"
            tooltip={t('Siguiente →')}
          >
            <ArrowRight />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
