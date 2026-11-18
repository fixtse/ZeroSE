'use client';
import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown, ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import { api, type Profile, type CatalogPage } from '../lib/api';
import { useTranslations } from '../i18n/provider';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from './ui/command';

type Item = { id: string; name: string };
type Page = CatalogPage<Item> & { available: boolean };

export function CalorieUserPicker({ profile }: { profile: Profile }) {
  const t = useTranslations();
  const [selected, setSelected] = useState<Item | undefined>(
    profile.calorieTracker
      ? {
          id: profile.calorieTracker.userId,
          name: profile.calorieTracker.userName,
        }
      : undefined,
  );
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page>();
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setPage(undefined);
    const timer = setTimeout(
      () => {
        void api<Page>(
          '/v1/admin/profiles/' +
            profile.bot +
            '/' +
            encodeURIComponent(profile.chatId) +
            '/calorie-users?' +
            new URLSearchParams({
              search: open ? search : '',
              offset: String(open ? offset : 0),
              limit: open ? '20' : '1',
              ...(!open && selected ? { id: selected.id } : {}),
            }),
          'GET',
          undefined,
          controller.signal,
        )
          .then((result) => {
            if (controller.signal.aborted) return;
            setAvailable(result.available);
            setPage(result);
            setSelected((old) => result.items.find((item) => item.id === old?.id) || old);
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setError(t('No se pudieron cargar los usuarios de Calorie Tracker.'));
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      open ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [profile.bot, profile.chatId, profile.homeAssistant?.url, open, search, offset, reload]);
  if (!available && !error && !selected) return null;
  return (
    <div className="settings-field">
      <Label htmlFor="profile-calorie-user">{t('Usuario de Calorie Tracker')}</Label>
      {available && <input type="hidden" name="calorieTrackerUserId" value={selected?.id || ''} />}
      <div className="flex min-w-0 items-center gap-2">
        <Popover
          open={open}
          onOpenChange={(value) => {
            setOpen(value);
            setSearch('');
            setOffset(0);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              id="profile-calorie-user"
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              disabled={!available}
              className="min-w-0 flex-1 justify-between"
              aria-describedby="profile-calorie-help"
            >
              <span className="truncate">{selected?.name || t('Sin usuario asignado')}</span>
              <ChevronsUpDown className="size-4 shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="p-0">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={t('Buscar usuarios…')}
                aria-label={t('Buscar usuarios de Calorie Tracker')}
                value={search}
                onValueChange={(value) => {
                  setSearch(value);
                  setOffset(0);
                }}
              />
              <CommandList>
                <CommandItem
                  value="unassigned"
                  onSelect={() => {
                    setSelected(undefined);
                    setOpen(false);
                  }}
                >
                  <Check className={!selected ? 'size-4' : 'size-4 opacity-0'} />
                  {t('Sin usuario asignado')}
                </CommandItem>
                {loading ? (
                  <p role="status" className="px-3 py-2 text-sm">
                    {t('Cargando…')}
                  </p>
                ) : error ? (
                  <p role="alert" className="px-3 py-2 text-sm">
                    {error}
                  </p>
                ) : (
                  <>
                    <CommandEmpty>{t('No hay usuarios que coincidan.')}</CommandEmpty>
                    {page?.items.map((item) => (
                      <CommandItem
                        key={item.id}
                        value={item.id}
                        onSelect={() => {
                          setSelected(item);
                          setOpen(false);
                        }}
                      >
                        <Check
                          className={
                            selected?.id === item.id
                              ? 'size-4 shrink-0'
                              : 'size-4 shrink-0 opacity-0'
                          }
                        />
                        <span className="truncate">{item.name}</span>
                      </CommandItem>
                    ))}
                    {page?.items.length === 0 && (
                      <p className="px-3 py-2 text-sm">{t('No hay usuarios que coincidan.')}</p>
                    )}
                  </>
                )}
              </CommandList>
              {page && page.total > 20 && (
                <div className="flex items-center justify-between border-t p-2">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    tooltip={t('Usuarios anteriores')}
                    disabled={!offset || loading}
                    onClick={() => setOffset(Math.max(0, offset - 20))}
                  >
                    <ArrowLeft />
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {offset + 1}–{Math.min(offset + 20, page.total)} / {page.total}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    tooltip={t('Usuarios siguientes')}
                    disabled={offset + 20 >= page.total || loading}
                    onClick={() => setOffset(offset + 20)}
                  >
                    <ArrowRight />
                  </Button>
                </div>
              )}
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="outline"
          size="icon"
          tooltip={t('Recargar usuarios de Calorie Tracker')}
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw />
        </Button>
      </div>
      <p id="profile-calorie-help" className="settings-help">
        {t('Los alimentos, recetas, diario y objetivos se guardan para el usuario seleccionado.')}
      </p>
      {error && !open && (
        <p role="alert" className="settings-help">
          {error}
        </p>
      )}
      {!available && selected && !loading && !error && (
        <p role="status" className="settings-help">
          {t('Calorie Tracker no está disponible en esta conexión.')}
        </p>
      )}
    </div>
  );
}
