'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, type CatalogPage, type Profile } from '../lib/api';
import { Label } from './ui/label';
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from './ui/command';
import { Button } from './ui/button';
import { ArrowLeft, ArrowRight } from 'lucide-react';

/** Bounded, on-demand HA suggestions shared by profile and member editors. */
export function HAEntityPicker({
  profile,
  id,
  name,
  label,
  domains,
  defaultValue = '',
  value,
  onChange,
  onSelect,
  pattern,
}: {
  profile: Profile;
  id: string;
  name?: string;
  label: string;
  domains: string;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSelect?: (value: string) => void;
  pattern?: string;
}) {
  const [local, setLocal] = useState(defaultValue);
  const [inputId, setInputId] = useState(id);
  const registerInput = useCallback((input: HTMLInputElement | null) => {
    if (input) setInputId(input.id);
  }, []);
  const query = value ?? local;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<CatalogPage<{ id: string; name: string }>>();
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPage(undefined);
    setError('');
    setLoading(true);
    const timer = setTimeout(() => {
      void api<CatalogPage<{ id: string; name: string }>>(
        '/v1/admin/profiles/' +
          profile.bot +
          '/' +
          encodeURIComponent(profile.chatId) +
          '/entities?' +
          new URLSearchParams({ search: query, domains, offset: String(offset), limit: '20' }),
        'GET',
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setPage(result);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              'No se pudieron cargar las entidades. Comprueba la conexión de Home Assistant.',
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, offset, domains, profile.bot, profile.chatId]);
  return (
    <div className="ha-entity-picker">
      <Label htmlFor={inputId}>{label}</Label>
      <Command
        shouldFilter={false}
        className="ha-entity-command"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <CommandInput
          ref={registerInput}
          id={id}
          name={name}
          aria-label={label}
          value={query}
          autoComplete="off"
          maxLength={200}
          pattern={pattern}
          placeholder={domains.split(',')[0] + '.…'}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
          }}
          onValueChange={(next) => {
            setLocal(next);
            onChange?.(next);
            setOffset(0);
            setPage(undefined);
            setOpen(true);
          }}
          aria-describedby={id + '-help'}
        />
        {open && (
          <CommandList aria-label={'Entidades · ' + label}>
            {loading ? (
              <p role="status" className="px-3 py-2 text-sm">
                Buscando entidades…
              </p>
            ) : error ? (
              <p role="alert" className="px-3 py-2 text-sm">
                {error}
              </p>
            ) : (
              <>
                <CommandEmpty>Sin entidades que coincidan.</CommandEmpty>
                {page?.items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => {
                      setLocal(item.id);
                      onChange?.(item.id);
                      onSelect?.(item.id);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{item.name}</span>
                      <small className="break-all text-muted-foreground">{item.id}</small>
                    </span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        )}
        {open && page && page.total > 20 && (
          <div className="action-group p-2">
            <Button
              type="button"
              size="icon"
              variant="outline"
              tooltip={'Sugerencias anteriores de ' + label}
              disabled={!offset || loading}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              <ArrowLeft />
            </Button>
            <small>
              {offset + 1}–{offset + page.items.length} de {page.total}
            </small>
            <Button
              type="button"
              size="icon"
              variant="outline"
              tooltip={'Más sugerencias de ' + label}
              disabled={offset + 20 >= page.total || loading}
              onClick={() => setOffset(offset + 20)}
            >
              <ArrowRight />
            </Button>
          </div>
        )}
      </Command>
      <small id={id + '-help'} role="status">
        {error ||
          (loading
            ? 'Buscando entidades…'
            : page?.items.length === 0
              ? 'Sin coincidencias.'
              : 'Escribe un nombre o identificador para ver sugerencias.')}
      </small>
    </div>
  );
}
