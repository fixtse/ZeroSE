'use client';
import { useState } from 'react';
import { api, type Profile, type CatalogPage } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Field, SelectField } from './settings-fields';
interface Item {
  id: string;
  name?: string;
  access?: string[];
  message?: string;
  kind?: string;
  status?: string;
  condition?: {
    source?: string;
    entity_id?: string;
    operator?: string;
    value?: unknown;
    mode?: string;
    conditions?: string[];
    hold_seconds?: number;
    horizon_hours?: number;
    minimum_probability?: number;
  };
  next_at?: string;
  wake_date?: string;
  last_fired?: string;
  scheduler_state?: string;
  repeat_seconds?: number;
  recurring?: boolean;
  cooldown_seconds?: number;
}
export function ProfileCatalogs({ profile }: { profile: Profile }) {
  const { busy, notice, run } = useAdminTask();
  const [kind, setKind] = useState('rules'),
    [ruleKind, setRuleKind] = useState(''),
    [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [page, setPage] = useState<CatalogPage<Item>>();
  const path = '/v1/admin/profiles/' + profile.bot + '/' + profile.chatId;
  async function load(start = 0) {
    const params = new URLSearchParams({
      search: query,
      limit: '20',
      offset: String(start),
      ...(kind === 'rules' && ruleKind ? { kind: ruleKind } : {}),
    });
    const result = await api<CatalogPage<Item>>(path + '/' + kind + '?' + params);
    setPage(result);
    setOffset(start);
  }
  return (
    <details className="settings-section">
      <summary>Catálogos, alertas y recordatorios</summary>
      <p>Consultas de solo lectura. No ejecutan servicios ni modifican horarios o permisos.</p>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <SelectField
        id="profile-catalog-kind"
        label="Catálogo"
        value={kind}
        onChange={(event) => {
          setKind(event.target.value);
          setPage(undefined);
          setOffset(0);
        }}
        disabled={busy}
      >
        <option value="rules">Alertas y recordatorios</option>
        <option value="entities">Entidades de Home Assistant</option>
        <option value="services">Servicios de Home Assistant</option>
      </SelectField>
      {kind === 'rules' ? (
        <SelectField
          id="profile-rule-kind"
          label="Tipo de regla"
          value={ruleKind}
          disabled={busy}
          onChange={(event) => {
            setRuleKind(event.target.value);
            setPage(undefined);
            setOffset(0);
          }}
        >
          <option value="">Todos</option>
          <option value="alert">Alertas</option>
          <option value="reminder">Recordatorios</option>
          <option value="timer">Temporizadores</option>
        </SelectField>
      ) : (
        <Field
          id="profile-catalog-search"
          label="Buscar por nombre o identificador"
          value={query}
          maxLength={200}
          disabled={busy}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(undefined);
            setOffset(0);
          }}
        />
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void run(() => load())}
      >
        Consultar catálogo
      </Button>
      {page && (
        <div className="catalog-results">
          {page.items.map((item) => (
            <div className="catalog-row" key={item.id}>
              <strong>{item.message || item.name || item.id}</strong>
              <small>{item.id}</small>
              {kind === 'rules' ? (
                <>
                  <p>
                    {item.kind} · {item.status}
                  </p>
                  {item.condition && (
                    <p>
                      {item.condition.source === 'weather'
                        ? 'Tiempo: ' +
                          (item.condition.mode || 'conditions') +
                          ' · ' +
                          (item.condition.conditions || []).join(', ') +
                          ' · horizonte ' +
                          item.condition.horizon_hours +
                          ' h · probabilidad mínima ' +
                          item.condition.minimum_probability +
                          '%'
                        : 'Sensor: ' +
                          item.condition.entity_id +
                          ' ' +
                          item.condition.operator +
                          ' ' +
                          String(item.condition.value) +
                          ' · duración ' +
                          item.condition.hold_seconds +
                          ' s'}
                    </p>
                  )}
                  <p>
                    Próxima: {item.next_at || item.wake_date || 'según condición'} · última:{' '}
                    {item.last_fired || 'nunca'}
                  </p>
                  <small>
                    Planificador: {item.scheduler_state || 'sin estado'} · repetición:{' '}
                    {item.repeat_seconds
                      ? item.repeat_seconds + ' s'
                      : item.recurring
                        ? 'recurrente'
                        : 'una vez'}{' '}
                    · espera: {item.cooldown_seconds || 0} s
                  </small>
                </>
              ) : (
                item.access && (
                  <p>
                    Usos configurados: {item.access.length ? item.access.join(', ') : 'ninguno'}
                  </p>
                )
              )}
            </div>
          ))}
          {!page.items.length && <p>No hay resultados.</p>}
          <div className="pager">
            <Button
              type="button"
              variant="ghost"
              disabled={busy || !offset}
              onClick={() => void run(() => load(Math.max(0, offset - 20)))}
            >
              ← Anterior
            </Button>
            <small>
              {page.total ? offset + 1 : 0}–{offset + page.items.length} de {page.total}
            </small>
            <Button
              type="button"
              variant="ghost"
              disabled={
                busy ||
                offset + page.items.length >= page.total ||
                (kind === 'rules' && page.next_offset === null)
              }
              onClick={() => void run(() => load(page.next_offset ?? offset + 20))}
            >
              Siguiente →
            </Button>
          </div>
        </div>
      )}
    </details>
  );
}
