'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export function SecretEditor({
  id,
  label = 'Clave API',
  name,
  value: controlled,
  configured,
  hint,
  preview,
  disabled,
  maxLength,
  onChange,
  deleteAction,
  actions,
}: {
  id: string;
  label?: string;
  name?: string;
  value?: string;
  configured?: boolean;
  hint?: string;
  preview?: string;
  disabled?: boolean;
  maxLength?: number;
  onChange?: (value: string) => void;
  deleteAction?: ReactNode;
  actions?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (preview) {
      setEditing(false);
      setDraft('');
    }
  }, [preview]);
  const value = controlled ?? draft;
  const expanded = editing || !!value;
  function change(next: string) {
    setDraft(next);
    onChange?.(next);
  }
  return (
    <div className="secret-editor">
      <Label
        id={id + '-label'}
        className="secret-editor-label"
        htmlFor={expanded ? id : id + '-edit'}
      >
        {label}
      </Label>
      <div className="secret-editor-value">
        {expanded ? (
          <Input
            id={id}
            name={name}
            type="password"
            autoComplete="new-password"
            aria-labelledby={id + '-label'}
            value={value}
            disabled={disabled}
            maxLength={maxLength}
            autoFocus={editing}
            placeholder={configured ? hint || '••••••••' : 'Introduce la credencial'}
            onChange={(event) => change(event.target.value)}
          />
        ) : (
          <span className="secret-editor-preview">
            {preview || (configured ? hint || '•••••••• · Configurada' : 'Sin configurar')}
          </span>
        )}
      </div>
      <div className="action-group">
        <Button
          id={id + '-edit'}
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          tooltip={
            expanded ? 'Cancelar cambio de ' + label : (configured ? 'Cambiar ' : 'Añadir ') + label
          }
          onClick={() => {
            if (expanded) change('');
            setEditing(!expanded);
          }}
        >
          {expanded ? <X /> : configured ? <Pencil /> : <Plus />}
        </Button>
        {deleteAction}
        {actions}
      </div>
    </div>
  );
}
