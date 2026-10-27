'use client';
import { useEffect, useState } from 'react';
import { api, type CatalogPage, type Profile } from '../lib/api';
import { Field } from './settings-fields';
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
}: {
  profile: Profile;
  id: string;
  name?: string;
  label: string;
  domains: string;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const [local, setLocal] = useState(defaultValue);
  const query = value ?? local;
  const [focused, setFocused] = useState(false);
  const [page, setPage] = useState<CatalogPage<{ id: string; name: string }>>();
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!focused) return;
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
  }, [focused, query, offset, domains, profile.bot, profile.chatId]);
  return (
    <div className="ha-entity-picker">
      <Field
        id={id}
        name={name}
        label={label}
        value={query}
        autoComplete="off"
        list={id + '-suggestions'}
        maxLength={200}
        placeholder={domains.split(',')[0] + '.…'}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          setLocal(event.target.value);
          onChange?.(event.target.value);
          setOffset(0);
        }}
        aria-describedby={id + '-help'}
      />
      <datalist id={id + '-suggestions'}>
        {page?.items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </datalist>
      <small id={id + '-help'} role="status">
        {error ||
          (loading
            ? 'Buscando entidades…'
            : page?.items.length === 0
              ? 'Sin coincidencias.'
              : 'Escribe un nombre o identificador para ver sugerencias.')}
      </small>
      {page && page.total > 20 && (
        <div className="action-group">
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
    </div>
  );
}
