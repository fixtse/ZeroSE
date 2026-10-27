'use client';
import { useState } from 'react';
import { X } from 'lucide-react';
import type { Profile } from '../lib/api';
import { HAEntityPicker } from './ha-entity-picker';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

export function HAEntityMultiPicker({
  profile,
  id,
  name,
  label,
  domains,
  defaultValues = [],
}: {
  profile: Profile;
  id: string;
  name: string;
  label: string;
  domains: string;
  defaultValues?: string[];
}) {
  const [selected, setSelected] = useState(() => [...new Set(defaultValues)]);
  const [query, setQuery] = useState('');
  return (
    <div className="grid min-w-0 gap-2">
      <input type="hidden" name={name} value={selected.join(',')} />
      <HAEntityPicker
        profile={profile}
        id={id}
        label={label}
        domains={domains}
        value={query}
        onChange={setQuery}
        onSelect={(entity) => {
          setSelected((previous) => (previous.includes(entity) ? previous : [...previous, entity]));
          setQuery('');
        }}
      />
      <div className="flex flex-wrap gap-2" aria-label={'Selección · ' + label}>
        {selected.map((entity) => (
          <Badge key={entity} variant="secondary" className="max-w-full gap-1">
            <span className="min-w-0 break-all whitespace-normal">{entity}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              tooltip={'Quitar ' + entity}
              onClick={() => setSelected((previous) => previous.filter((item) => item !== entity))}
            >
              <X aria-hidden="true" />
            </Button>
          </Badge>
        ))}
      </div>
      <small>
        Sin selección se permiten todos los sensores compatibles. Los cambios se aplican al guardar
        el perfil.
      </small>
    </div>
  );
}
