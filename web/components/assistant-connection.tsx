'use client';
import { Check } from 'lucide-react';
import { useAdminApi } from '../hooks/use-admin-api';
import { useEffect, useState } from 'react';
import { type AssistantSummary, type Profile } from '../lib/api';
import { SelectField } from './settings-fields';
import { Button } from './ui/button';
import { useAdminTask } from '../hooks/use-admin-task';

export function AssistantConnectionName({ id }: { id: string }) {
  const api = useAdminApi();
  const [name, setName] = useState(id === 'zero' ? 'Zero' : 'Asistente');
  useEffect(() => {
    let active = true;
    if (id !== 'zero')
      void api<AssistantSummary>('/v1/admin/setup/assistants/' + id)
        .then((value) => {
          if (active) setName(value.name);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);
  return <>{name}</>;
}
export function AssistantConnectionField({
  profile,
  disabled,
}: {
  profile?: Profile;
  disabled: boolean;
}) {
  const api = useAdminApi();
  const [items, setItems] = useState<AssistantSummary[]>([]),
    [total, setTotal] = useState(0);
  const { busy, run } = useAdminTask();
  async function load(offset = 0) {
    const page = await api<{ items: AssistantSummary[]; total: number }>(
      '/v1/admin/setup/assistants?limit=50&offset=' + offset,
    );
    setItems((old) => (offset ? [...old, ...page.items] : page.items));
    setTotal(page.total);
  }
  useEffect(() => {
    void run(async () => {
      await load();
      if (profile && profile.bot !== 'zero') {
        const current = await api<AssistantSummary>('/v1/admin/setup/assistants/' + profile.bot);
        setItems((old) => (old.some((item) => item.id === current.id) ? old : [...old, current]));
      }
    });
  }, []);
  const choices = items.length ? items : [{ id: 'zero', name: 'Zero' }];
  return (
    <div>
      <SelectField
        id="profile-bot"
        name="bot"
        label="Conexión del asistente"
        value={profile?.bot}
        defaultValue={profile ? undefined : 'zero'}
        disabled={disabled || !!profile}
      >
        {profile && !choices.some((item) => item.id === profile.bot) && (
          <option value={profile.bot}>Asistente actual</option>
        )}
        {choices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </SelectField>
      {!profile && items.length < total && (
        <div className="form-actions">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => load(items.length))}
            size="icon"
            tooltip="Ver más asistentes"
          >
            <Check />
          </Button>
        </div>
      )}
    </div>
  );
}
