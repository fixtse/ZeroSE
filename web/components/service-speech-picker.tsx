'use client';
import { useEffect, useId, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronsUpDown } from 'lucide-react';
import { api, type CatalogPage } from '../lib/api';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { Command, CommandInput, CommandList, CommandItem } from './ui/command';

export function ServiceSpeechPicker({
  kind,
  label,
  value,
  language = '',
  onChange,
}: {
  kind: 'languages' | 'voices';
  label: string;
  value: string;
  language?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<CatalogPage<{ id: string; name: string }>>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPage(undefined);
    setError('');
    const timer = setTimeout(() => {
      void api<NonNullable<typeof page>>(
        '/v1/admin/setup/services/speech?' +
          new URLSearchParams({
            kind,
            language,
            search,
            offset: String(offset),
            limit: '20',
          }),
        'GET',
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setPage(result);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, search, offset, kind, language]);
  return (
    <div className="settings-field">
      <Label htmlFor={id}>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            className="service-choice"
          >
            <span>{value || 'Seleccionar…'}</span>
            <ChevronsUpDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Buscar…"
              aria-label={'Buscar ' + label.toLowerCase()}
              value={search}
              onValueChange={(value) => {
                setSearch(value);
                setOffset(0);
              }}
            />
            <CommandList>
              {page?.items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onSelect={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">{item.name}</span>
                  {value === item.id && <Check />}
                </CommandItem>
              ))}
              {error && (
                <p role="alert" className="p-3 text-sm">
                  {error}
                </p>
              )}
              {!page && !error && (
                <p role="status" className="p-3 text-sm">
                  Consultando Edge TTS…
                </p>
              )}
              {page?.total === 0 && <p className="p-3 text-sm">Sin resultados.</p>}
            </CommandList>
            {page && page.total > 20 && (
              <div className="action-group p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  tooltip="Anterior"
                  disabled={!offset}
                  onClick={() => setOffset(Math.max(0, offset - 20))}
                >
                  <ArrowLeft />
                </Button>
                <small>
                  {offset + 1}–{offset + page.items.length} de {page.total}
                </small>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  tooltip="Siguiente"
                  disabled={page.next_offset === null}
                  onClick={() => setOffset(page.next_offset!)}
                >
                  <ArrowRight />
                </Button>
              </div>
            )}
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
