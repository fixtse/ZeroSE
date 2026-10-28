'use client';
import { Check, Fingerprint, Plus, RefreshCw, ShieldPlus, ShieldOff, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authClient, authResult } from '../lib/auth-client';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Field } from './settings-fields';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/alert-dialog';

export function AccountFactors({
  section,
  active,
}: {
  section: 'two-factor' | 'passkeys';
  active: boolean;
}) {
  const { busy, setNotice, run } = useAdminTask();
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const factorForm = useRef<HTMLFormElement>(null);
  const [enrollment, setEnrollment] = useState<{ totpURI: string; backupCodes: string[] }>();
  const [keys, setKeys] = useState<{ id: string; name?: string | null }[]>([]);
  async function refresh() {
    if (section === 'two-factor') {
      const session = authResult(
        await authClient.getSession({ query: { disableCookieCache: true } }),
      );
      setEnabled(!!session.data?.user.twoFactorEnabled);
    } else {
      const result = authResult(await authClient.passkey.listUserPasskeys());
      setKeys(result.data || []);
    }
    setLoaded(true);
  }
  useEffect(() => {
    if (active) void run(refresh);
  }, [active]);
  async function toggle(form: HTMLFormElement) {
    const password = String(new FormData(form).get('password'));
    if (enabled) {
      authResult(await authClient.twoFactor.disable({ password }));
      setEnrollment(undefined);
      setNotice('Segundo factor desactivado.');
    } else {
      const result = authResult(await authClient.twoFactor.enable({ password }));
      if (result.data && 'totpURI' in result.data) setEnrollment(result.data);
    }
    form.reset();
    await refresh();
  }
  function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (enabled) setConfirmDisable(true);
    else void run(() => toggle(form));
  }
  return (
    <Card className="security-panel">
      <div className="security-panel-heading">
        <div className="security-panel-title">
          <h3>{section === 'two-factor' ? 'Autenticación en dos pasos' : 'Passkeys'}</h3>
          {section === 'two-factor' && loaded && (
            <Badge variant="secondary">{enabled ? 'Activada' : 'Desactivada'}</Badge>
          )}
          {section === 'passkeys' && loaded && <Badge variant="secondary">{keys.length}</Badge>}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          tooltip="Recargar métodos de acceso"
          disabled={busy || !!enrollment}
          onClick={() => void run(refresh)}
        >
          <RefreshCw />
        </Button>
      </div>
      {section === 'two-factor' ? (
        <>
          <p>
            {enabled
              ? 'Al entrar con contraseña se pedirá un código de tu aplicación.'
              : 'Añade los códigos de tu aplicación de autenticación como segundo paso de acceso.'}
          </p>
          {!enrollment && (
            <form ref={factorForm} className="security-inline-form" onSubmit={configure}>
              <Field
                id="factor-password"
                name="password"
                label="Contraseña actual"
                type="password"
                autoComplete="current-password"
                required
                disabled={busy}
              />
              <Button
                disabled={busy || !loaded}
                size="icon"
                variant={enabled ? 'outline' : 'default'}
                className={enabled ? 'danger' : undefined}
                tooltip={enabled ? 'Desactivar 2FA' : 'Configurar 2FA'}
              >
                {enabled ? <ShieldOff /> : <ShieldPlus />}
              </Button>
            </form>
          )}
          <AlertDialog open={confirmDisable} onOpenChange={setConfirmDisable}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>¿Desactivar la autenticación en dos pasos?</AlertDialogTitle>
                <AlertDialogDescription>
                  Tu cuenta dejará de pedir el código de la aplicación al entrar con contraseña.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    const form = factorForm.current;
                    if (form?.reportValidity()) void run(() => toggle(form));
                  }}
                >
                  Desactivar
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {enrollment && (
            <div className="security-enrollment">
              <p>
                Añade esta clave como una cuenta Zero en tu aplicación: códigos de 6 cifras cada 30
                segundos.
              </p>
              <Field
                id="factor-secret"
                label="Clave de configuración manual"
                readOnly
                value={new URL(enrollment.totpURI).searchParams.get('secret') || ''}
              />
              <p>
                Guarda los códigos de recuperación en un lugar seguro. Cada uno sirve una sola vez.
              </p>
              <pre>{enrollment.backupCodes.join('\n')}</pre>
              <form
                className="security-inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const code = String(new FormData(event.currentTarget).get('code'));
                  void run(async () => {
                    authResult(await authClient.twoFactor.verifyTotp({ code }));
                    setEnrollment(undefined);
                    await refresh();
                    setNotice('Segundo factor activado.');
                  });
                }}
              >
                <Field
                  id="factor-code"
                  name="code"
                  label="Código de la aplicación"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  required
                  disabled={busy}
                />
                <Button disabled={busy} size="icon" tooltip="Confirmar y activar">
                  <Check />
                </Button>
              </form>
            </div>
          )}
        </>
      ) : (
        <>
          <p>
            Usa la huella, el reconocimiento facial o una llave de seguridad. Requiere HTTPS o
            localhost.
          </p>
          <form
            className="security-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const name = String(new FormData(form).get('name'));
              void run(async () => {
                authResult(await authClient.passkey.addPasskey({ name }));
                form.reset();
                await refresh();
                setNotice('Passkey añadida.');
              });
            }}
          >
            <Field
              id="passkey-name"
              name="name"
              label="Nombre del dispositivo"
              maxLength={100}
              required
              disabled={busy}
            />
            <Button disabled={busy || !loaded} size="icon" tooltip="Añadir passkey">
              <Plus />
            </Button>
          </form>
          {loaded && keys.length === 0 && <p>No tienes passkeys registradas.</p>}
          <div className="security-key-list">
            {keys.map((key) => (
              <div className="security-key-row" key={key.id}>
                <Fingerprint aria-hidden="true" />
                <strong>{key.name || 'Passkey'}</strong>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="danger"
                      disabled={busy}
                      size="icon"
                      tooltip={'Eliminar ' + (key.name || 'passkey')}
                    >
                      <Trash2 />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>¿Eliminar {key.name || 'esta passkey'}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Esta credencial dejará de permitir el acceso a Zero. Conserva otro método de
                        acceso a tu cuenta.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() =>
                          void run(async () => {
                            authResult(await authClient.passkey.deletePasskey({ id: key.id }));
                            await refresh();
                            setNotice('Passkey eliminada.');
                          })
                        }
                      >
                        Eliminar passkey
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
