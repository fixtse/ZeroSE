'use client';
import { Check, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { authClient, authResult } from '../lib/auth-client';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Field } from './settings-fields';

export function AccountFactors() {
  const { busy, setNotice, run } = useAdminTask();
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [enrollment, setEnrollment] = useState<{ totpURI: string; backupCodes: string[] }>();
  const [keys, setKeys] = useState<{ id: string; name?: string | null }[]>([]);
  async function refresh() {
    const session = authResult(await authClient.getSession());
    setEnabled(!!session.data?.user.twoFactorEnabled);
    const result = authResult(await authClient.passkey.listUserPasskeys());
    setKeys(result.data || []);
    setLoaded(true);
  }
  useEffect(() => {
    void run(refresh);
  }, []);
  function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get('password'));
    void run(async () => {
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
    });
  }
  return (
    <>
      <div className="settings-section">
        <h3>Autenticación en dos pasos</h3>
        <p>
          {enabled
            ? 'Activada. Al entrar con contraseña se pedirá un código de tu aplicación.'
            : 'Añade un código de una aplicación de autenticación a tu contraseña.'}
        </p>
        <form onSubmit={configure}>
          <Field
            id="factor-password"
            name="password"
            label="Contraseña actual"
            type="password"
            autoComplete="current-password"
            required
          />
          <div className="form-actions">
            <Button
              disabled={busy || !loaded}
              size="icon"
              tooltip={enabled ? 'Desactivar 2FA' : 'Configurar 2FA'}
            >
              <Check />
            </Button>
          </div>
        </form>
        {enrollment && (
          <div>
            <p>
              En tu aplicación de autenticación, añade una cuenta llamada Zero con esta clave. Elige
              códigos basados en tiempo, de 6 cifras y 30 segundos. Guarda la clave en privado.
            </p>
            <Field
              id="factor-secret"
              label="Clave de configuración manual"
              readOnly
              value={new URL(enrollment.totpURI).searchParams.get('secret') || ''}
            />
            <p>
              Guarda estos códigos de recuperación en un lugar seguro. Cada código sirve una sola
              vez.
            </p>
            <pre>{enrollment.backupCodes.join('\n')}</pre>
            <form
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
              />
              <div className="form-actions">
                <Button disabled={busy} size="icon" tooltip="Confirmar y activar">
                  <Check />
                </Button>
              </div>
            </form>
          </div>
        )}
      </div>
      <div className="settings-section">
        <h3>Passkeys</h3>
        <p>
          Entra con la huella, el reconocimiento facial o la llave de seguridad de tu dispositivo.
          Requiere HTTPS o localhost.
        </p>
        <form
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
          />
          <div className="form-actions">
            <Button disabled={busy || !loaded} size="icon" tooltip="Añadir passkey">
              <Plus />
            </Button>
          </div>
        </form>
        {loaded && keys.length === 0 && <p>No tienes passkeys registradas.</p>}
        {keys.map((key) => (
          <div className="profile-row" key={key.id}>
            <strong>{key.name || 'Passkey'}</strong>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  authResult(await authClient.passkey.deletePasskey({ id: key.id }));
                  await refresh();
                  setNotice('Passkey eliminada.');
                })
              }
              size="icon"
              tooltip="Eliminar"
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}
