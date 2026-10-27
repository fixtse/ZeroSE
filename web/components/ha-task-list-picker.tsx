'use client';
import { ArrowLeft, ArrowRight, Check, Search } from 'lucide-react';
import { useAdminApi } from '../hooks/use-admin-api';
import { useState } from 'react';
import { type Profile, type CatalogPage } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Field } from './settings-fields';

export function HATaskListPicker({ profile }: { profile: Profile }) {
  const api = useAdminApi();
  const [entity, setEntity] = useState(profile.homeAssistant?.taskListEntity || '');
  const [page, setPage] = useState<CatalogPage<{ id: string; name: string }>>();
  const [offset, setOffset] = useState(0);
  const { busy, run } = useAdminTask();
  async function discover(start: number) {
    setPage(
      await api(
        '/v1/admin/profiles/' +
          profile.bot +
          '/' +
          profile.chatId +
          '/entities?' +
          new URLSearchParams({ search: 'todo.', limit: '20', offset: String(start) }),
      ),
    );
    setOffset(start);
  }
  return (
    <div className="settings-section">
      <Field
        id="profile-ha-task-list"
        name="ha-taskListEntity"
        label="Lista de tareas de Home Assistant"
        placeholder="todo.personal"
        pattern="todo\.[a-z0-9_]+"
        value={entity}
        onChange={(event) => setEntity(event.target.value)}
      />
      <p>
        Se sugiere Home Assistant si hay listas disponibles. Elegir una lista no cambia el proveedor
        ni mueve tareas.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void run(() => discover(0))}
        size="icon"
        tooltip="Buscar listas disponibles"
      >
        <Search />
      </Button>
      {page && (
        <>
          {!page.items.length && <p>No se encontraron listas.</p>}
          {page.items
            .filter((item) => item.id.startsWith('todo.'))
            .map((item) => (
              <div className="profile-row" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.id}</small>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEntity(item.id)}
                  size="icon"
                  tooltip="Seleccionar"
                >
                  <Check />
                </Button>
              </div>
            ))}
          <div className="form-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy || offset === 0}
              onClick={() => void run(() => discover(Math.max(0, offset - 20)))}
              size="icon"
              tooltip="Anterior"
            >
              <ArrowLeft />
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || offset + 20 >= page.total}
              onClick={() => void run(() => discover(offset + 20))}
              size="icon"
              tooltip="Siguiente"
            >
              <ArrowRight />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
