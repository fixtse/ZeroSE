'use client';
import { useEffect, useState } from 'react';
import { ChevronDown, Link, ShieldCheck } from 'lucide-react';
import { api, type Profile } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { SecretEditor } from './secret-editor';
import { Field } from './settings-fields';
import { Button } from './ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
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

const outcomes: Record<string, string> = {
  connected: 'Google conectado y verificado. Se han sustituido las conexiones individuales.',
  cancelled: 'Autorización cancelada. Se conserva la conexión anterior.',
  failed:
    'No se pudo verificar Google. Comprueba las APIs y concede todos los permisos. Se conserva la conexión anterior; inicia una autorización nueva.',
  changed:
    'La conexión cambió durante la autorización. Recarga el perfil e inicia una autorización nueva.',
};
export function GoogleConnectionSettings({ profile }: { profile: Profile | null }) {
  const google = profile?.google;
  const legacy = Object.values(google?.credentials || {}).find((value) => value?.clientId);
  const [clientId, setClientId] = useState(google?.clientId || legacy?.clientId || '');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [outcome, setOutcome] = useState('');
  const [embedded, setEmbedded] = useState(false);
  const [wrongOrigin, setWrongOrigin] = useState(false);
  const { busy, run } = useAdminTask();
  const path = profile
    ? '/v1/admin/profiles/' +
      profile.bot +
      '/' +
      encodeURIComponent(profile.chatId) +
      '/google/oauth'
    : '';
  useEffect(() => {
    setEmbedded(window.self !== window.top);
    if (path)
      void run(async () => {
        const info = await api<{ redirectUri: string; scopes: string[] }>(path);
        setRedirectUri(info.redirectUri);
        setWrongOrigin(location.origin !== new URL(info.redirectUri).origin);
        const names: Record<string, string> = {
          calendar: 'Calendar',
          tasks: 'Tasks',
          documents: 'Docs',
          drive: 'Drive',
        };
        setServices(info.scopes.map((scope) => names[scope.split('/').pop()!] || scope));
      });
    const url = new URL(location.href);
    const result = url.searchParams.get('googleOAuth');
    if (result) {
      setOutcome(outcomes[result] || 'Autorización no válida.');
      url.searchParams.delete('googleOAuth');
      history.replaceState(null, '', url);
    }
  }, [path]);
  return (
    <section className="google-connection">
      <div className="flex items-center justify-between gap-3">
        <h3 className="settings-heading">Conexión Google</h3>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="icon"
              tooltip={profile?.hasGoogle ? 'Volver a conectar Google' : 'Conectar Google'}
              disabled={
                !profile || busy || !redirectUri || embedded || wrongOrigin || !services.length
              }
            >
              <Link />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Conectar Google</AlertDialogTitle>
              <AlertDialogDescription>
                Se abrirá Google para elegir una cuenta y autorizar las herramientas Google
                permitidas y guardadas en este perfil. Las tareas de Home Assistant no solicitan
                permisos de Google Tasks. Tras verificar el acceso, esta conexión sustituirá las
                conexiones individuales del perfil. Si cancelas o falla la verificación, se
                conservarán las anteriores.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ authorizationUrl: string }>(path, 'POST', {
                      clientId,
                      clientSecret,
                    });
                    const state = new URL(result.authorizationUrl).searchParams.get('state');
                    await api(path + '/check', 'POST', { state });
                    setClientSecret('');
                    window.location.assign(result.authorizationUrl);
                  })
                }
              >
                Continuar con Google
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {(embedded || wrongOrigin) && redirectUri && (
        <p>
          Para autorizar Google,{' '}
          <a
            className="underline"
            target="_blank"
            rel="noopener noreferrer"
            href={
              new URL(redirectUri).origin +
              '/admin/?' +
              new URLSearchParams({
                page: 'people',
                profile: profile ? profile.bot + '/' + profile.chatId : '',
                profileTab: 'google',
              })
            }
          >
            abre este perfil en la dirección pública de Zero
          </a>
          .
        </p>
      )}
      {outcome && <p role="status">{outcome}</p>}
      <p>
        <ShieldCheck className="inline size-4" aria-hidden="true" />{' '}
        {google?.refreshTokenHint
          ? 'Conexión compartida configurada.'
          : profile?.hasGoogle
            ? 'Conexiones anteriores guardadas. Conecta Google para unificarlas.'
            : 'Google aún no está conectado.'}
      </p>
      <p>
        Permisos solicitados:{' '}
        {services.length ? services.join(', ') : 'ninguna herramienta Google guardada'}.
      </p>
      <div className="settings-grid">
        <Field
          id="google-oauth-client-id"
          label="OAuth client ID"
          value={clientId}
          autoComplete="off"
          onChange={(event) => setClientId(event.target.value)}
        />
        <SecretEditor
          id="google-oauth-client-secret"
          label="OAuth client secret"
          value={clientSecret}
          configured={!!(google?.clientSecretHint || legacy?.clientSecretHint)}
          hint={google?.clientSecretHint || legacy?.clientSecretHint}
          disabled={busy}
          onChange={setClientSecret}
        />
      </div>
      <Collapsible className="settings-section">
        <CollapsibleTrigger
          type="button"
          className="group flex w-full items-center justify-between gap-2 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Configurar APIs de Google
          <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p>
            Guarda primero los cambios de Herramientas permitidas y del proveedor de tareas. Usa un
            cliente de tipo «Aplicación web». La conexión se guarda automáticamente al completar la
            autorización.
          </p>
          <ul className="grid gap-2 text-sm">
            {services.map((service) => {
              const apis: Record<string, string> = {
                Calendar: 'calendar-json.googleapis.com',
                Tasks: 'tasks.googleapis.com',
                Docs: 'docs.googleapis.com',
                Drive: 'drive.googleapis.com',
              };
              return (
                <li key={service}>
                  <a
                    className="text-primary underline underline-offset-4"
                    href={'https://console.cloud.google.com/apis/library/' + apis[service]}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Activar Google {service} API
                  </a>
                </li>
              );
            })}
          </ul>
          {redirectUri && (
            <p className="break-all">
              URI de redirección autorizada en Google Cloud: <code>{redirectUri}</code>
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
      {!profile && <p>Guarda primero el perfil para conectar Google.</p>}
    </section>
  );
}
