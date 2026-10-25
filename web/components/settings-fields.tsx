import type { ComponentProps, ReactNode } from 'react';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
export function Field({
  id,
  label,
  ...props
}: ComponentProps<typeof Input> & { id: string; label: string }) {
  return (
    <div className="settings-field">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}
export function SelectField({
  id,
  label,
  children,
  ...props
}: ComponentProps<'select'> & { id: string; label: string; children: ReactNode }) {
  return (
    <div className="settings-field">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} {...props}>
        {children}
      </select>
    </div>
  );
}
export function CheckField({
  id,
  label,
  ...props
}: ComponentProps<typeof Checkbox> & { id: string; label: string }) {
  return (
    <Label className="check" htmlFor={id}>
      <Checkbox id={id} {...props} />
      {label}
    </Label>
  );
}
