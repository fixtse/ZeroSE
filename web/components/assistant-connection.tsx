'use client';
import { useEffect, useState } from 'react';
import { api, type AssistantSummary, type Profile } from '../lib/api';
import { SelectField } from './settings-fields';
import { Button } from './ui/button';
import { useAdminTask } from '../hooks/use-admin-task';

export function AssistantConnectionName({ id }: { id: string }) {
  const [name, setName] = useState(
    id === 'zero'
      ? 'Zero'
      : id === 'salem'
        ? 'Salem'
        : id === 'standard'
          ? 'Estándar'
          : 'Asistente',
  );
  useEffect(() => {
    let active = true;
    if (!['zero', 'salem', 'standard'].includes(id))
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
  const [items, setItems] = useState<AssistantSummary[]>([]),
    [total, setTotal] = useState(0);
  const { busy, notice, run } = useAdminTask();
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
      if (profile && !['zero', 'salem', 'standard'].includes(profile.bot)) {
        const current = await api<AssistantSummary>('/v1/admin/setup/assistants/' + profile.bot);
        setItems((old) => (old.some((item) => item.id === current.id) ? old : [...old, current]));
      }
    });
  }, []);
  const choices = items.length
    ? items
    : [
        { id: 'zero', name: 'Zero' },
        { id: 'salem', name: 'Salem' },
      ];
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
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => load(items.length))}
        >
          Ver más asistentes
        </Button>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
