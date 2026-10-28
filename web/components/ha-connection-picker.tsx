'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { api } from '../lib/api';
import { CheckField, Field, SelectField } from './settings-fields';
import { Button } from './ui/button';
export interface HAConnectionChoice { id: string; name: string; url: string }
export function HAConnectionPicker({ selected, active, onChange }: {
  selected: HAConnectionChoice[];
  active: string;
  onChange(selected: HAConnectionChoice[], active: string): void;
}) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ items: HAConnectionChoice[]; total: number; next_offset: number | null }>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setPage(undefined);
    setError('');
    const timer = setTimeout(() => {
      void api<NonNullable<typeof page>>('/v1/admin/home-assistant/connections?' + new URLSearchParams({search, offset: String(offset), limit: '20'}), 'GET', undefined, controller.signal)
        .then((value) => { if (!controller.signal.aborted) setPage(value); })
        .catch(() => { if (!controller.signal.aborted) setError('No se pudieron cargar las conexiones.'); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, offset]);
  const items = [...selected.filter((item) => !page?.items.some((other) => other.id === item.id)), ...(page?.items || [])];
  return <div className="grid gap-3">
    <Field id="profile-ha-connection-search" label="Conexiones de Zero" placeholder="Buscar servidor conectado" value={search} maxLength={200} onChange={(event) => {setSearch(event.target.value); setOffset(0);}} />
    {items.map((item) => <CheckField key={item.id} id={'ha-connection-' + item.id} label={item.name + ' · ' + item.url} checked={selected.some((value) => value.id === item.id)} onCheckedChange={(checked) => {
      const next = checked === true ? [...selected, item] : selected.filter((value) => value.id !== item.id);
      onChange(next, next.some((value) => value.id === active) ? active : next[0]?.id || '');
    }} />)}
    {error && <small role="alert">{error}</small>}
    {!page && !error && <small role="status">Cargando conexiones…</small>}
    {page?.total === 0 && <small>No hay conexiones de Zero con esta búsqueda.</small>}
    {page && page.total > 20 && <div className="action-group">
      <Button type="button" size="icon-xs" variant="ghost" tooltip="Conexiones anteriores" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}><ArrowLeft /></Button>
      <small>{offset + 1}–{Math.min(offset + 20, page.total)} de {page.total}</small>
      <Button type="button" size="icon-xs" variant="ghost" tooltip="Conexiones siguientes" disabled={page.next_offset === null} onClick={() => setOffset(page.next_offset!)}><ArrowRight /></Button>
    </div>}
    {selected.length > 0 && <SelectField id="profile-ha-active-connection" label="Servidor activo" value={active} onChange={(event) => onChange(selected, event.target.value)}>
      {selected.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.url}</option>)}
    </SelectField>}
    <small>{selected.length ? 'Las herramientas y entidades usan el servidor activo.' : 'Selecciona servidores conectados con Zero o introduce una conexión manual.'}</small>
  </div>;
}
