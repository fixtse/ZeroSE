'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Field, CheckField } from './settings-fields';
export function AccountSettings() {
  const { busy, notice, setNotice, run } = useAdminTask();
  const [recovery, setRecovery] = useState<{ available: boolean; enabled: boolean }>();
  useEffect(() => {
    void run(async () => setRecovery(await api('/api/auth/recovery/settings')));
  }, []);
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
    <Card className="panel">
      <h2>Cuenta y recuperación</h2>
      <p>Actualiza tu contraseña y configura la recuperación por Telegram.</p>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
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
        <Button disabled={busy}>Cambiar contraseña</Button>
      </form>
      <div className="settings-section">
        <h3>Recuperación por Telegram</h3>
        {recovery ? (
          <form
            key={String(recovery.enabled)}
            onSubmit={(event) => {
              event.preventDefault();
              const enabled = new FormData(event.currentTarget).has('enabled');
              void run(async () => {
                const value = await api<{ message: string }>(
                  '/api/auth/recovery/settings',
                  'POST',
                  { enabled },
                );
                setRecovery({ ...recovery, enabled });
                setNotice(value.message);
              });
            }}
          >
            <CheckField
              id="account-recovery-enabled"
              name="enabled"
              label="Permitir restablecer la contraseña con un código de Telegram"
              defaultChecked={recovery.enabled}
              disabled={(!recovery.available && !recovery.enabled) || busy}
            />
            <p>
              {recovery.available
                ? 'El código se enviará al propietario privado configurado en Zero.'
                : 'Configura primero el bot y el propietario privado de Zero para activar la recuperación.'}
            </p>
            <Button variant="outline" disabled={busy || (!recovery.available && !recovery.enabled)}>
              Guardar recuperación
            </Button>
          </form>
        ) : (
          <p>Cargando configuración…</p>
        )}
      </div>
    </Card>
  );
}
