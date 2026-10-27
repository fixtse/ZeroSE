'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { api } from '../lib/api';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Button } from './ui/button';

export interface PairingTarget {
  bot: string;
  chatId: string;
  label: string;
  kind: 'user' | 'group';
}
interface Page {
  items: PairingTarget[];
  total: number;
  next_offset: number | null;
}

export function PairingProfilePicker({
  pairingId,
  selected,
  onSelect,
}: {
  pairingId: string;
  selected?: PairingTarget;
  onSelect(target?: PairingTarget): void;
}) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setPage(undefined);
    const timer = setTimeout(() => {
      void api<Page>(
        '/v1/admin/setup/pairings/' +
          encodeURIComponent(pairingId) +
          '/profiles?' +
          new URLSearchParams({ search, offset: String(offset), limit: '20' }),
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
              'No se pudieron cargar los perfiles. Comprueba que la solicitud no haya caducado.',
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [pairingId, search, offset]);
  return (
    <div className="grid min-w-0 gap-2">
      <Label htmlFor="pairing-profile-search">Buscar usuario o grupo</Label>
      <Input
        id="pairing-profile-search"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setOffset(0);
        }}
        placeholder="Nombre o ID del chat"
      />
      <Label htmlFor="pairing-profile">Conectar a usuario o grupo</Label>
      <select
        id="pairing-profile"
        value={selected ? selected.bot + ':' + selected.chatId : ''}
        required
        onChange={(event) =>
          onSelect(
            page?.items.find((item) => item.bot + ':' + item.chatId === event.target.value) ||
              (event.target.value === (selected ? selected.bot + ':' + selected.chatId : '')
                ? selected
                : undefined),
          )
        }
      >
        <option value="">Selecciona un perfil activo</option>
        {selected &&
          !page?.items.some(
            (item) => item.chatId === selected.chatId && item.bot === selected.bot,
          ) && (
            <option value={selected.bot + ':' + selected.chatId}>
              {selected.label} · {selected.kind === 'group' ? 'Grupo' : 'Usuario'} · {selected.bot}{' '}
              · {selected.chatId}
            </option>
          )}
        {page?.items.map((item) => (
          <option key={item.bot + ':' + item.chatId} value={item.bot + ':' + item.chatId}>
            {item.label} · {item.kind === 'group' ? 'Grupo' : 'Usuario'} · {item.bot} ·{' '}
            {item.chatId}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <small>
          {loading
            ? 'Cargando perfiles…'
            : error ||
              (page?.total
                ? `${offset + 1}–${Math.min(offset + 20, page.total)} de ${page.total} perfiles`
                : 'No hay perfiles activos con esta búsqueda.')}
        </small>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          tooltip="Perfiles anteriores"
          disabled={loading || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          tooltip="Perfiles siguientes"
          disabled={loading || page?.next_offset == null}
          onClick={() => setOffset(page!.next_offset!)}
        >
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}
