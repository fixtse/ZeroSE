'use client';
import { useEffect, useState } from 'react';
import { api, type Settings } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';

interface Catalog {
  items: { id: string; name: string }[];
  total: number;
  frigateAvailable: boolean;
}
const validService = /^[a-z_]+\.[a-z_]+$/;
export function HomeAssistantPermissions({
  settings,
  busy,
  save,
  reload,
}: {
  settings: Settings;
  busy: boolean;
  save: (value: Settings) => void;
  reload: () => void;
}) {
  const [services, setServices] = useState(settings.services);
  const [draft, setDraft] = useState('');
  const [assist, setAssist] = useState(settings.assist);
  const [homeAssistant, setHomeAssistant] = useState(settings.homeAssistant);
  const [frigate, setFrigate] = useState(settings.frigate);
  const [catalog, setCatalog] = useState<Catalog>();
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void api<Catalog>(
        '/v1/admin/setup/services?limit=20&offset=' +
          offset +
          '&search=' +
          encodeURIComponent(draft.trim()),
      )
        .then((value) => {
          if (active) {
            setCatalog(value);
            setError('');
          }
        })
        .catch((reason: unknown) => {
          if (active) {
            setCatalog(undefined);
            setError(
              reason instanceof Error ? reason.message : 'No se pudo consultar Home Assistant.',
            );
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [draft, offset]);
  function add(values: string[]) {
    const items = values.map((value) => value.trim()).filter(Boolean);
    if (items.some((value) => !validService.test(value))) {
      setError('Usa el formato domain.service.');
      return false;
    }
    if (new Set([...services, ...items]).size > 100) {
      setError('Puedes permitir hasta 100 servicios.');
      return false;
    }
    setServices((current) => [...new Set([...current, ...items])]);
    setDraft('');
    setOffset(0);
    setError('');
    return true;
  }
  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        const pending = draft
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        if (!add(pending)) return;
        save({
          ...settings,
          homeAssistant,
          assist,
          frigate,
          services: [...new Set([...services, ...pending])],
        });
      }}
    >
      <div className="toggle-list">
        <Label className="check">
          <Checkbox
            checked={homeAssistant}
            onCheckedChange={(value) => setHomeAssistant(value === true)}
          />
          Herramientas de Home Assistant
        </Label>
        <Label className="check">
          <Checkbox checked={assist} onCheckedChange={(value) => setAssist(value === true)} />
          Delegación a Assist
        </Label>
        <small>La delegación permite conversation.process automáticamente.</small>
        <Label className="check">
          <Checkbox
            checked={frigate}
            disabled={!catalog?.frigateAvailable}
            onCheckedChange={(value) => setFrigate(value === true)}
          />
          Servicios de Frigate
        </Label>
        {!catalog?.frigateAvailable && (
          <small>
            {loading
              ? 'Comprobando Frigate…'
              : 'Frigate solo está disponible cuando Home Assistant ofrece servicios frigate.*.'}
          </small>
        )}
      </div>
      <Label htmlFor="allowed-service">Servicios permitidos</Label>
      <div className="flex flex-wrap gap-2" aria-label="Servicios seleccionados">
        {services.map((service) => (
          <Button
            key={service}
            type="button"
            className="quiet"
            aria-label={'Quitar ' + service}
            onClick={() => setServices((current) => current.filter((value) => value !== service))}
          >
            {service} ×
          </Button>
        ))}
      </div>
      <Input
        id="allowed-service"
        value={draft}
        placeholder="Buscar o escribir domain.service"
        onChange={(event) => {
          const value = event.target.value;
          setOffset(0);
          if (value.includes(',')) {
            const parts = value.split(',');
            const tail = parts.pop() || '';
            if (add(parts)) setDraft(tail);
            else setDraft(value);
          } else setDraft(value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (draft.trim()) add([draft]);
          }
        }}
      />
      <small>
        Selecciona una opción o escribe un servicio y pulsa coma o Intro para añadirlo. Los
        recordatorios existentes conservan sus horarios.
      </small>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p role="status">Buscando servicios…</p>
      ) : (
        catalog && (
          <div>
            <div className="flex flex-wrap gap-2" aria-label="Servicios disponibles">
              {catalog.items
                .filter((item) => !services.includes(item.id))
                .map((item) => (
                  <Button
                    type="button"
                    className="quiet"
                    key={item.id}
                    onClick={() => add([item.id])}
                  >
                    {item.id} · {item.name}
                  </Button>
                ))}
            </div>
            {catalog.total === 0 && <p>No hay servicios coincidentes.</p>}
            <div className="form-actions">
              <Button
                type="button"
                className="quiet"
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 20))}
              >
                Anterior
              </Button>
              <small>{catalog.total} servicios</small>
              <Button
                type="button"
                className="quiet"
                disabled={offset + 20 >= catalog.total}
                onClick={() => setOffset((value) => value + 20)}
              >
                Siguiente
              </Button>
            </div>
          </div>
        )
      )}
      <div className="form-actions">
        <Button disabled={busy}>Guardar ajustes →</Button>
        <Button type="button" className="quiet" disabled={busy} onClick={reload}>
          Recargar
        </Button>
      </div>
    </form>
  );
}
