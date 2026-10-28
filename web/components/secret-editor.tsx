'use client';
import { useState, type ReactNode } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import { Field } from './settings-fields';

export function SecretEditor({
  id,
  label = 'API key',
  value,
  configured,
  hint,
  onChange,
  deleteAction,
}: {
  id: string;
  label?: string;
  value: string;
  configured?: boolean;
  hint?: string;
  onChange: (value: string) => void;
  deleteAction?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const expanded = editing || !!value;
  return (
    <div className="secret-editor">
      <div className="secret-editor-heading">
        <span>{label}</span>
        <div className="action-group">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip={
              expanded
                ? 'Cancelar cambio de ' + label
                : (configured ? 'Cambiar ' : 'Añadir ') + label
            }
            onClick={() => {
              if (expanded) onChange('');
              setEditing(!expanded);
            }}
          >
            {expanded ? <X /> : configured ? <Pencil /> : <Plus />}
          </Button>
          {deleteAction}
        </div>
      </div>
      {expanded ? (
        <Field
          id={id}
          label={'Nueva ' + label.toLowerCase()}
          type="password"
          autoComplete="new-password"
          value={value}
          placeholder={configured ? hint || '••••••••' : 'Introduce la credencial'}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <span className="secret-editor-preview">
          {configured ? hint || '•••••••• · Configurada' : 'Sin configurar'}
        </span>
      )}
    </div>
  );
}
