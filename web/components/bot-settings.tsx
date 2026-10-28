'use client';
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
      setNotice('Conexión guardada. Los webhooks se registran solo con el botón de confirmación.');
      window.dispatchEvent(new CustomEvent('assistant-telegram-changed', { detail: id }));
    });
  }
  return (
    <details className="settings-section assistant-telegram-settings">
      <summary>Telegram de {name} · opcional</summary>
      <p>
        Sin esta conexión, {name} sigue disponible en Home Assistant. Conecta un bot propio para
        hablarle directamente por Telegram.
      </p>
      {value ? (
        <>
          <p className="connection-status">
            <span className={value.enabled ? 'status-indicator enabled' : 'status-indicator'} />
            {value.configured
              ? 'Bot configurado' + (value.accountId ? ' · ID ' + value.accountId : '')
              : 'Sin bot configurado'}
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
                label="Token de Telegram"
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
                label="Transporte de Telegram"
                value={transport}
                onChange={(event) => setTransport(event.target.value as Connection['transport'])}
              >
                <option value="disabled">Desactivado</option>
                <option value="webhook">Webhook</option>
                <option value="polling">Polling · sin URL pública</option>
              </SelectField>
              {transport === 'webhook' && (
                <Field
                  id={'telegram-webhook-' + id}
                  name="webhookUrl"
                  label="URL pública del webhook"
                  type="url"
                  maxLength={2048}
                  value={webhookUrl}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                />
              )}
              <CheckField
                id={'telegram-enabled-' + id}
                name="enabled"
                label="Activar Telegram para este asistente"
                defaultChecked={value.enabled}
              />

              <p>
                Los secretos guardados muestran solo una referencia parcial. Cambiar de bot conserva
                los perfiles y conversaciones existentes.
              </p>
            </fieldset>
          </form>
          <div className="connection-toolbar">
            <div className="action-group" role="group" aria-label="Guardar conexión">
              <Button
                form={'telegram-form-' + id}
                disabled={busy}
                size="icon"
                tooltip="Guardar conexión de Telegram"
              >
                <Save />
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void run(load)}
                size="icon"
                tooltip="Recargar conexión"
              >
                <RefreshCw />
              </Button>
            </div>
            <div
              className="action-group connection-operations"
              role="group"
              aria-label="Operaciones de Telegram"
            >
              <Button
                type="button"
                variant="outline"
                disabled={busy || !value.configured}
                onClick={() => void run(async () => setStatus(await api(endpoint + '/status')))}
                size="icon"
                tooltip="Comprobar webhook y estado en Telegram"
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
                    tooltip="Registrar webhook"
                  >
                    <Webhook />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>¿Registrar el webhook de {name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Telegram enviará los mensajes del bot {value.accountId} a {value.webhookUrl}.
                      Esto sustituye el webhook de ese bot y conserva las actualizaciones
                      pendientes.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          await api(endpoint + '/register', 'POST', {
                            confirm: true,
                            revision: value.revision,
                          });
                          setNotice('Telegram ha confirmado el registro del webhook.');
                          setStatus(undefined);
                        })
                      }
                    >
                      Confirmar registro
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
                    tooltip="Desactivar Telegram y eliminar credenciales"
                  >
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>¿Desactivar Telegram de {name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Se eliminarán el webhook y el token guardado y se desactivará el bot. Se
                      conservan los perfiles, las conversaciones y los mensajes pendientes.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
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
                          setNotice('Telegram desactivado. Webhook y credenciales eliminados.');
                        })
                      }
                    >
                      Desactivar y eliminar
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
          {status && (
            <div role="status">
              {value.enabled && value.transport === 'webhook' && status.url &&
              status.url === status.expectedUrl && status.reachable === true ? (
                <p className="flex items-center gap-2">
                  <Check className="size-4 text-primary" aria-hidden="true" />
                  Webhook verificado
                </p>
              ) : (
                <>
                  <p className="flex items-center gap-2">
                    <TriangleAlert className="size-4 text-primary" aria-hidden="true" />
                    {!value.enabled || value.transport === 'disabled'
                      ? 'Conexión de Telegram desactivada.'
                      : value.transport === 'polling'
                        ? 'Telegram utiliza polling.'
                        : !status.url
                          ? 'Telegram no tiene un webhook registrado.'
                          : status.url !== status.expectedUrl
                            ? 'El webhook registrado no coincide con la URL guardada.'
                            : status.probeError || 'No se ha podido verificar el webhook.'}
                  </p>
                  {status.url && <p>Webhook actual: {status.url}</p>}
                  <p>Mensajes pendientes: {status.pending}</p>
                  {value.enabled && value.transport === 'webhook' && status.reachable === false &&
                    status.lastError && (
                      <p>
                        Último error registrado
                        {status.lastErrorAt
                          ? ' (' + new Date(status.lastErrorAt * 1000).toLocaleString('es-ES') + ')'
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
        <p>Cargando conexión…</p>
      )}
    </details>
  );
}
