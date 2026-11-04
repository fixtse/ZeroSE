'use client';
import { useTranslations } from '../i18n/provider';
import { Activity, Check, RefreshCw, Save, Trash2, TriangleAlert, Webhook } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { SecretEditor } from './secret-editor';
import { Button } from './ui/button';
import { Field, CheckField, SelectField } from './settings-fields';
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
interface Connection {
  id: string;
  configured: boolean;
  tokenHint?: string;
  enabled: boolean;
  transport: 'disabled' | 'webhook' | 'polling';
  webhookUrl: string;
  revision: number;
  accountId: string;
  source: 'saved' | 'server' | 'none';
}
interface Status {
  url: string;
  expectedUrl: string;
  pending: number;
  lastError?: string;
  lastErrorAt?: number;
  reachable?: boolean;
  probeError?: string;
}
export function BotSettings({ id, name }: { id: string; name: string }) {
  const t = useTranslations();
  const { busy, setNotice, run } = useAdminTask();
  const [value, setValue] = useState<Connection>(),
    [version, setVersion] = useState(0),
    [status, setStatus] = useState<Status>();
  const [token, setToken] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [transport, setTransport] = useState<Connection['transport']>('webhook');
  const endpoint = '/v1/admin/setup/assistants/' + encodeURIComponent(id) + '/telegram';
  async function load() {
    const connection = await api<Connection>(endpoint);
    setValue(connection);
    setTransport(connection.transport);
    setWebhookUrl(connection.webhookUrl);
    setStatus(undefined);
    setToken('');
    setVersion((v) => v + 1);
  }
  useEffect(() => {
    void run(load);
  }, [id]);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      setValue(
        await api(endpoint, 'PUT', {
          token: String(data.get('token') || '').trim(),
          enabled: data.has('enabled'),
          transport: data.get('transport'),
          webhookUrl: webhookUrl.trim(),
          clearToken: false,
          revision: value?.revision,
        }),
      );
      setStatus(undefined);
      setToken('');
      setVersion((v) => v + 1);
      setNotice(
        t('Conexión guardada. Los webhooks se registran solo con el botón de confirmación.'),
      );
      window.dispatchEvent(new CustomEvent('assistant-telegram-changed', { detail: id }));
    });
  }
  return (
    <details className="settings-section assistant-telegram-settings">
      <summary>
        {t('Telegram de')} {name} {t('· opcional')}
      </summary>
      <p>
        {t('Sin esta conexión,')} {name}{' '}
        {t(
          'sigue disponible en Home Assistant. Conecta un bot propio para hablarle directamente por Telegram.',
        )}
      </p>
      {value ? (
        <>
          <p className="connection-status">
            <span className={value.enabled ? 'status-indicator enabled' : 'status-indicator'} />
            {value.configured
              ? t('Bot configurado') + (value.accountId ? ' · ID ' + value.accountId : '')
              : t('Sin bot configurado')}
            {value.source === 'server'
              ? ' · Valores originales del servidor. Puedes sustituirlos aquí.'
              : ''}
          </p>
          <form
            id={'telegram-form-' + id}
            key={version}
            onSubmit={save}
            className="telegram-connection-form"
          >
            <fieldset disabled={busy}>
              <SecretEditor
                id={'telegram-token-' + id}
                name="token"
                label={t('Token de Telegram')}
                value={token}
                configured={value.configured}
                hint={value.tokenHint}
                maxLength={300}
                disabled={busy}
                onChange={setToken}
              />

              <SelectField
                id={'telegram-transport-' + id}
                name="transport"
                label={t('Transporte de Telegram')}
                value={transport}
                onChange={(event) => setTransport(event.target.value as Connection['transport'])}
              >
                <option value="disabled">{t('Desactivado')}</option>
                <option value="webhook">Webhook</option>
                <option value="polling">{t('Polling · sin URL pública')}</option>
              </SelectField>
              {transport === 'webhook' && (
                <Field
                  id={'telegram-webhook-' + id}
                  name="webhookUrl"
                  label={t('URL pública del webhook')}
                  type="url"
                  maxLength={2048}
                  value={webhookUrl}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                />
              )}
              <CheckField
                id={'telegram-enabled-' + id}
                name="enabled"
                label={t('Activar Telegram para este asistente')}
                defaultChecked={value.enabled}
              />

              <p>
                {t(
                  'Los secretos guardados muestran solo una referencia parcial. Cambiar de bot conserva los perfiles y conversaciones existentes.',
                )}
              </p>
            </fieldset>
          </form>
          <div className="connection-toolbar">
            <div className="action-group" role="group" aria-label={t('Guardar conexión')}>
              <Button
                form={'telegram-form-' + id}
                disabled={busy}
                size="icon"
                tooltip={t('Guardar conexión de Telegram')}
              >
                <Save />
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void run(load)}
                size="icon"
                tooltip={t('Recargar conexión')}
              >
                <RefreshCw />
              </Button>
            </div>
            <div
              className="action-group connection-operations"
              role="group"
              aria-label={t('Operaciones de Telegram')}
            >
              <Button
                type="button"
                variant="outline"
                disabled={busy || !value.configured}
                onClick={() => void run(async () => setStatus(await api(endpoint + '/status')))}
                size="icon"
                tooltip={t('Comprobar webhook y estado en Telegram')}
              >
                <Activity />
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !value.enabled || value.transport !== 'webhook'}
                    size="icon"
                    tooltip={t('Registrar webhook')}
                  >
                    <Webhook />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('¿Registrar el webhook de')} {name}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('Telegram enviará los mensajes del bot')} {value.accountId} {t('a')}{' '}
                      {value.webhookUrl}
                      {t(
                        '. Esto sustituye el webhook de ese bot y conserva las actualizaciones pendientes.',
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                    <AlertDialogAction
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          await api(endpoint + '/register', 'POST', {
                            confirm: true,
                            revision: value.revision,
                          });
                          setNotice(t('Telegram ha confirmado el registro del webhook.'));
                          setStatus(undefined);
                        })
                      }
                    >
                      {t('Confirmar registro')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !value.configured}
                    size="icon"
                    className="danger"
                    tooltip={t('Desactivar Telegram y eliminar credenciales')}
                  >
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('¿Desactivar Telegram de')} {name}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(
                        'Se eliminarán el webhook y el token guardado y se desactivará el bot. Se conservan los perfiles, las conversaciones y los mensajes pendientes.',
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                    <AlertDialogAction
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          await api(endpoint + '/remove', 'POST', {
                            confirm: true,
                            revision: value.revision,
                          });
                          await load();
                          window.dispatchEvent(
                            new CustomEvent('assistant-telegram-changed', { detail: id }),
                          );
                          setNotice(t('Telegram desactivado. Webhook y credenciales eliminados.'));
                        })
                      }
                    >
                      {t('Desactivar y eliminar')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
          {status && (
            <div role="status">
              {value.enabled &&
              value.transport === 'webhook' &&
              status.url &&
              status.url === status.expectedUrl &&
              status.reachable === true ? (
                <p className="flex items-center gap-2">
                  <Check className="size-4 text-primary" aria-hidden="true" />
                  {t('Webhook verificado')}
                </p>
              ) : (
                <>
                  <p className="flex items-center gap-2">
                    <TriangleAlert className="size-4 text-primary" aria-hidden="true" />
                    {!value.enabled || value.transport === 'disabled'
                      ? t('Conexión de Telegram desactivada.')
                      : value.transport === 'polling'
                        ? t('Telegram utiliza polling.')
                        : !status.url
                          ? t('Telegram no tiene un webhook registrado.')
                          : status.url !== status.expectedUrl
                            ? t('El webhook registrado no coincide con la URL guardada.')
                            : status.probeError || t('No se ha podido verificar el webhook.')}
                  </p>
                  {status.url && (
                    <p>
                      {t('Webhook actual:')} {status.url}
                    </p>
                  )}
                  <p>
                    {t('Mensajes pendientes:')} {status.pending}
                  </p>
                  {value.enabled &&
                    value.transport === 'webhook' &&
                    status.reachable === false &&
                    status.lastError && (
                      <p>
                        {t('Último error registrado')}
                        {status.lastErrorAt
                          ? ' (' +
                            new Date(status.lastErrorAt * 1000).toLocaleString(t.locale) +
                            ')'
                          : ''}
                        : {status.lastError}
                      </p>
                    )}
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <p>{t('Cargando conexión…')}</p>
      )}
    </details>
  );
}
