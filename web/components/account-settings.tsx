'use client';
import { KeyRound } from 'lucide-react';
import type { FormEvent } from 'react';
import { AccountFactors } from './account-factors';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Field } from './settings-fields';
export function AccountSettings() {
  const { busy, setNotice, run } = useAdminTask();
  function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form);
    void run(async () => {
      if (data.get('newPassword') !== data.get('confirmPassword'))
        throw new Error('Las contraseñas no coinciden.');
      await api('/api/auth/change-password', 'POST', {
        currentPassword: data.get('currentPassword'),
        newPassword: data.get('newPassword'),
        revokeOtherSessions: true,
      });
      form.reset();
      setNotice('Contraseña actualizada. Las demás sesiones se han cerrado.');
    });
  }
  return (
    <Card className="panel account-settings">
      <h2>Cuenta y recuperación</h2>
      <p>Actualiza tu contraseña y administra los métodos de acceso a tu cuenta.</p>
      <form className="account-password-form" onSubmit={change}>
        <Field
          id="account-current-password"
          name="currentPassword"
          label="Contraseña actual"
          type="password"
          autoComplete="current-password"
          required
        />
        <div className="settings-grid">
          <Field
            id="account-new-password"
            name="newPassword"
            label="Nueva contraseña"
            type="password"
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            required
          />
          <Field
            id="account-confirm-password"
            name="confirmPassword"
            label="Confirmar nueva contraseña"
            type="password"
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            required
          />
        </div>
        <Button disabled={busy} size="icon" tooltip="Cambiar contraseña">
          <KeyRound />
        </Button>
      </form>
      <AccountFactors />
    </Card>
  );
}
