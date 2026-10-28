'use client';
import { Fingerprint, KeyRound, ShieldCheck } from 'lucide-react';
import type { FormEvent } from 'react';
import { AccountFactors } from './account-factors';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { useUrlState } from '../hooks/use-url-state';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Field } from './settings-fields';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';

export function AccountSettings() {
  const { busy, setNotice, run } = useAdminTask();
  const [tab, setTab] = useUrlState('securityTab', 'password');
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
    <section className="security-settings">
      <h2>Seguridad</h2>
      <Tabs
        value={['password', 'two-factor', 'passkeys'].includes(tab) ? tab : 'password'}
        onValueChange={setTab}
        className="provider-settings"
      >
        <TabsList aria-label="Secciones de seguridad" className="provider-tabs-list">
          <TabsTrigger value="password">
            <KeyRound aria-hidden="true" />
            Contraseña
          </TabsTrigger>
          <TabsTrigger value="two-factor">
            <ShieldCheck aria-hidden="true" />
            Autenticación en dos pasos
          </TabsTrigger>
          <TabsTrigger value="passkeys">
            <Fingerprint aria-hidden="true" />
            Passkeys
          </TabsTrigger>
        </TabsList>
        <TabsContent value="password" forceMount>
          <Card className="security-panel">
            <div className="security-panel-heading">
              <h3>Contraseña</h3>
              <Button
                form="account-password-form"
                disabled={busy}
                size="icon"
                tooltip="Cambiar contraseña"
              >
                <KeyRound />
              </Button>
            </div>
            <form id="account-password-form" onSubmit={change}>
              <fieldset disabled={busy}>
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
              </fieldset>
            </form>
          </Card>
        </TabsContent>
        <TabsContent value="two-factor" forceMount>
          <AccountFactors section="two-factor" active={tab === 'two-factor'} />
        </TabsContent>
        <TabsContent value="passkeys" forceMount>
          <AccountFactors section="passkeys" active={tab === 'passkeys'} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
