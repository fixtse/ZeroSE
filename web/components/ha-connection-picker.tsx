'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronsUpDown } from 'lucide-react';
import { api } from '../lib/api';
import { Command, CommandInput, CommandList, CommandItem } from './ui/command';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { Button } from './ui/button';
export interface HAConnectionChoice {
  id: string;
  name: string;
  url: string;
}
export function HAConnectionPicker({
  selected,
  active,
  onChange,
}: {
  selected: HAConnectionChoice[];
  active: string;
  onChange(selected: HAConnectionChoice[], active: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{
    items: HAConnectionChoice[];
    total: number;
    next_offset: number | null;
  }>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPage(undefined);
    setError('');
    const timer = setTimeout(() => {
      void api<NonNullable<typeof page>>(
        '/v1/admin/home-assistant/connections?' +
          new URLSearchParams({ search, offset: String(offset), limit: '20' }),
        'GET',
        undefined,
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted) setPage(value);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError('No se pudieron cargar las conexiones.');
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, search, offset]);
  const items = page?.items || [];
  const chosen = selected.find((item) => item.id === active) || selected[0];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Conexión de Home Assistant"
          className="ha-connection-trigger"
        >
          <span>{chosen ? chosen.name + ' · ' + chosen.url : 'Conexión manual'}</span>
          <ChevronsUpDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <Command shouldFilter={false}>
          <CommandInput
            aria-label="Buscar conexión"
            placeholder="Buscar conexión…"
            value={search}
            onValueChange={(value) => {
              setSearch(value);
              setOffset(0);
            }}
          />
          <CommandList>
            {items.map((item) => (
              <CommandItem
                key={item.id}
                value={item.id}
                onSelect={() => {
                  onChange([item], item.id);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 break-words">
                  {item.name} · {item.url}
                </span>
                {chosen?.id === item.id && <Check aria-hidden="true" />}
              </CommandItem>
            ))}
            {error && (
              <p className="p-3 text-sm" role="alert">
                {error}
              </p>
            )}
            {!page && !error && (
              <p className="p-3 text-sm" role="status">
                Cargando conexiones…
              </p>
            )}
            {page?.total === 0 && (
              <p className="p-3 text-sm">No hay conexiones con esta búsqueda.</p>
            )}
            {page && page.total > 20 && (
              <div className="action-group p-2">
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  tooltip="Conexiones anteriores"
                  disabled={!offset}
                  onClick={() => setOffset(Math.max(0, offset - 20))}
                >
                  <ArrowLeft />
                </Button>
                <small>
                  {offset + 1}–{Math.min(offset + 20, page.total)} de {page.total}
                </small>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  tooltip="Conexiones siguientes"
                  disabled={page.next_offset === null}
                  onClick={() => setOffset(page.next_offset!)}
                >
                  <ArrowRight />
                </Button>
              </div>
            )}
            <CommandItem
              value="manual"
              className="border-t rounded-none"
              onSelect={() => {
                onChange([], '');
                setOpen(false);
              }}
            >
              <span className="flex-1">Conexión manual</span>
              {!chosen && <Check aria-hidden="true" />}
            </CommandItem>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
