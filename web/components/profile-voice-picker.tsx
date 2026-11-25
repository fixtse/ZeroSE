'use client';
import { ArrowLeft, ArrowRight, Check, ChevronsUpDown, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from '../i18n/provider';
import { api, type CatalogPage } from '../lib/api';
import { Button } from './ui/button';
import { Command, CommandInput, CommandItem, CommandList } from './ui/command';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

interface Voice {
  id: string;
  name: string;
}

const pageSize = 50;

export function ProfileVoicePicker({
  catalogPath,
  engine,
  language,
  value,
  disabled,
  onChange,
}: {
  catalogPath: string;
  engine: string;
  language: string;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<CatalogPage<Voice>>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Voice>();
  const canLoad = !!catalogPath && engine !== 'default';

  useEffect(() => {
    if (!canLoad) return;
    const controller = new AbortController();
    setPage(undefined);
    setError('');
    const timer = setTimeout(() => {
      void api<CatalogPage<Voice>>(
        catalogPath,
        'POST',
        { kind: 'voices', engine, language, search, offset, limit: pageSize },
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) setPage(result);
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setError(
              error instanceof Error ? error.message : t('No se pudieron cargar las voces.'),
            );
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [canLoad, catalogPath, engine, language, search, offset, revision]);

  useEffect(() => {
    const voice = page?.items.find((item) => item.id === value);
    if (voice) setSelected(voice);
  }, [page, value]);

  const defaultLabel = t('Voz predeterminada del motor');
  const selectedLabel = value
    ? page?.items.find((voice) => voice.id === value)?.name ||
      (selected?.id === value ? selected.name : value + ' ' + t('(guardada)'))
    : defaultLabel;

  function select(voice: Voice) {
    setSelected(voice);
    onChange(voice.id);
    setOpen(false);
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
      <div className="settings-field">
        <Label id="profile-tts-voice-label" htmlFor="profile-tts-voice">
          {t('Voz TTS')}
        </Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id="profile-tts-voice"
              type="button"
              variant="outline"
              role="combobox"
              aria-labelledby="profile-tts-voice-label"
              aria-expanded={open}
              disabled={disabled}
              className="h-12 w-full justify-between"
            >
              <span className="truncate">{selectedLabel}</span>
              <ChevronsUpDown className="shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent>
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={t('Buscar voz…')}
                aria-label={t('Buscar voz TTS')}
                maxLength={200}
                value={search}
                onValueChange={(query) => {
                  setSearch(query);
                  setOffset(0);
                }}
              />
              <CommandList>
                <CommandItem
                  value="default-voice"
                  onSelect={() => select({ id: '', name: defaultLabel })}
                >
                  <span className="min-w-0 flex-1">{defaultLabel}</span>
                  {!value && <Check className="size-4 shrink-0" />}
                </CommandItem>
                {value &&
                  !search &&
                  offset === 0 &&
                  !page?.items.some((voice) => voice.id === value) && (
                    <CommandItem
                      value={'saved:' + value}
                      onSelect={() => select({ id: value, name: selectedLabel })}
                    >
                      <span className="min-w-0 flex-1">{selectedLabel}</span>
                      <Check className="size-4 shrink-0" />
                    </CommandItem>
                  )}
                {page?.items.map((voice) => (
                  <CommandItem
                    key={voice.id}
                    value={'voice:' + voice.id}
                    onSelect={() => select(voice)}
                  >
                    <span className="min-w-0 flex-1">{voice.name}</span>
                    {value === voice.id && <Check className="size-4 shrink-0" />}
                  </CommandItem>
                ))}
                {error && (
                  <p role="alert" className="p-3 text-sm">
                    {error}
                  </p>
                )}
                {canLoad && !page && !error && (
                  <p role="status" className="p-3 text-sm">
                    {t('Consultando voces…')}
                  </p>
                )}
                {page?.total === 0 && <p className="p-3 text-sm">{t('Sin resultados.')}</p>}
              </CommandList>
              {page && page.total > pageSize && (
                <div className="action-group p-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    tooltip={t('Anterior')}
                    disabled={!offset}
                    onClick={() => setOffset(Math.max(0, offset - pageSize))}
                  >
                    <ArrowLeft />
                  </Button>
                  <small>
                    {offset + 1}–{offset + page.items.length} {t('de')} {page.total}
                  </small>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    tooltip={t('Siguiente')}
                    disabled={offset + page.items.length >= page.total}
                    onClick={() => setOffset(offset + pageSize)}
                  >
                    <ArrowRight />
                  </Button>
                </div>
              )}
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !canLoad}
        onClick={() => {
          setOffset(0);
          setRevision((current) => current + 1);
        }}
        size="icon"
        tooltip={t('Recargar voces TTS')}
        className="size-12"
      >
        <RefreshCw />
      </Button>
    </div>
  );
}
