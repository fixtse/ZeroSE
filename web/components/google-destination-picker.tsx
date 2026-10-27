'use client';
import { Check, ChevronsUpDown, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type Profile } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from './ui/command';

const destinations = {
  calendar: {
    key: 'calendarId',
    kind: 'calendars',
    label: 'Calendario',
    fallback: 'primary',
    defaultLabel: 'Calendario principal',
  },
  tasks: {
    key: 'taskListId',
    kind: 'task-lists',
    label: 'Lista de tareas',
    fallback: '@default',
    defaultLabel: 'Lista predeterminada',
  },
  docs: {
    key: 'documentFolderId',
    kind: 'document-folders',
    label: 'Carpeta de documentos',
    fallback: '',
    defaultLabel: 'Mi unidad (sin carpeta)',
  },
} as const;
type Item = { id: string; name: string };
export function GoogleDestinationPicker({
  profile,
  service,
}: {
  profile: Profile | null;
  service: keyof typeof destinations;
}) {
  const config = destinations[service];
  const field = config.key;
  const [selected, setSelected] = useState<Item>({
    id: profile?.google?.[field] || config.fallback,
    name:
      profile?.google?.destinationNames?.[field] ||
      ((profile?.google?.[field] || config.fallback) === config.fallback
        ? config.defaultLabel
        : profile?.google?.[field] || config.defaultLabel),
  });
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { busy, run, setNotice } = useAdminTask();
  const request = useRef<{ sequence: number; controller?: AbortController }>({ sequence: 0 });
  const path = profile
    ? '/v1/admin/profiles/' + profile.bot + '/' + encodeURIComponent(profile.chatId) + '/google/'
    : '';
  async function load(token = '') {
    if (!path) return;
    request.current.controller?.abort();
    const controller = new AbortController();
    const sequence = ++request.current.sequence;
    request.current.controller = controller;
    setLoading(true);
    setError('');
    try {
      // A reload must reach Google, rather than reuse cached discovery results.
      const page = await api<{ items: Item[]; nextPageToken?: string }>(
        path + config.kind + '?' + new URLSearchParams({ search, limit: '20', pageToken: token }),
        'GET',
        undefined,
        controller.signal,
      );
      if (sequence !== request.current.sequence) return;
      setItems((previous) =>
        token
          ? [
              ...previous,
              ...page.items.filter((item) => !previous.some((old) => old.id === item.id)),
            ]
          : page.items,
      );
      setNext(page.nextPageToken);
      setSelected((previous) => page.items.find((item) => item.id === previous.id) || previous);
    } catch (error) {
      if (!controller.signal.aborted && sequence === request.current.sequence)
        setError(error instanceof Error ? error.message : 'No se pudieron cargar las opciones.');
    } finally {
      if (sequence === request.current.sequence) setLoading(false);
    }
  }
  useEffect(() => {
    if (!open || !profile?.hasGoogle) {
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      setItems([]);
      setNext(undefined);
      void load();
    }, 200);
    return () => {
      clearTimeout(timer);
      request.current.sequence++;
      request.current.controller?.abort();
    };
  }, [open, search, path, profile?.hasGoogle]);
  async function select(item: Item) {
    await run(async () => {
      const result = await api<{ selected: Item }>(path + 'destination', 'PUT', {
        kind: config.kind,
        id: item.id,
      });
      setSelected(result.selected);
      setOpen(false);
      setNotice(config.label + ' guardado.');
    });
  }
  const defaultItem = { id: config.fallback, name: config.defaultLabel };
  const options = [defaultItem, ...items.filter((item) => item.id !== config.fallback)].filter(
    (item) =>
      item.id !== config.fallback ||
      !search ||
      item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const controlId = 'google-destination-' + service;
  return (
    <div className="settings-field">
      <Label htmlFor={controlId}>{config.label}</Label>
      <div className="flex min-w-0 items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={controlId}
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label={config.label}
              disabled={!profile?.hasGoogle || busy}
              className="min-w-0 flex-1 justify-between font-normal"
            >
              <span className="truncate">{selected.name}</span>
              <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent>
            <Command shouldFilter={false}>
              <CommandInput
                aria-label={'Buscar ' + config.label.toLocaleLowerCase()}
                placeholder="Buscar…"
                value={search}
                onValueChange={setSearch}
              />
              {loading && (
                <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
                  Cargando…
                </p>
              )}
              {error && (
                <p role="alert" className="px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}
              <CommandList aria-label={config.label}>
                {!loading && !error && <CommandEmpty>No hay resultados.</CommandEmpty>}
                {options.map((item) => (
                  <CommandItem
                    key={item.id || '__root'}
                    value={item.id || '__root'}
                    disabled={busy}
                    onSelect={() => void select(item)}
                  >
                    <Check
                      className={
                        'size-4 shrink-0 ' +
                        (selected.id === item.id ? 'opacity-100 text-primary' : 'opacity-0')
                      }
                    />
                    <span className="truncate">{item.name}</span>
                  </CommandItem>
                ))}
                {next && (
                  <CommandItem value="__more" disabled={loading} onSelect={() => void load(next)}>
                    Mostrar más resultados
                  </CommandItem>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="outline"
          size="icon"
          tooltip={'Recargar ' + config.label.toLocaleLowerCase()}
          disabled={!profile?.hasGoogle || busy || loading}
          onClick={() => void load()}
        >
          {loading ? <Loader2 className="motion-safe:animate-spin" /> : <RefreshCw />}
        </Button>
      </div>
      {!profile?.hasGoogle && <small>Conecta Google para elegir un destino.</small>}
      {!open && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
