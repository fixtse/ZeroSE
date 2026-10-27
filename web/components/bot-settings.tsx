'use client';
import { Activity, RefreshCw, Save, Trash2, Webhook } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
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
}
export function BotSettings({ id, name }: { id: string; name: string }) {
  const { busy, setNotice, run } = useAdminTask();
  const [value, setValue] = useState<Connection>(),
    [version, setVersion] = useState(0),
    [status, setStatus] = useState<Status>();
  const endpoint = '/v1/admin/setup/assistants/' + encodeURIComponent(id) + '/telegram';
  async function load() {
    setValue(await api<Connection>(endpoint));
    setStatus(undefined);
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
          webhookUrl: String(data.get('webhookUrl') || '').trim(),
          clearToken: data.has('clearToken'),
          revision: value?.revision,
        }),
      );
      setStatus(undefined);
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
              <Field
                id={'telegram-token-' + id}
                name="token"
                label="Token del bot de Telegram"
                type="password"
                autoComplete="off"
                maxLength={300}
                placeholder={value.tokenHint || (value.configured ? '••••••••' : '123456:token')}
              />
              <SelectField
                id={'telegram-transport-' + id}
                name="transport"
                label="Transporte de Telegram"
                defaultValue={value.transport}
              >
                <option value="disabled">Desactivado</option>
                <option value="webhook">Webhook</option>
                <option value="polling">Polling · sin URL pública</option>
              </SelectField>
              <Field
                id={'telegram-webhook-' + id}
                name="webhookUrl"
                label="URL pública del webhook"
                type="url"
                maxLength={2048}
                defaultValue={value.webhookUrl}
              />
              <CheckField
                id={'telegram-enabled-' + id}
                name="enabled"
                label="Activar Telegram para este asistente"
                defaultChecked={value.enabled}
              />
              <CheckField
                id={'telegram-clear-' + id}
                name="clearToken"
                label="Borrar el token guardado (desactiva primero Telegram)"
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
                tooltip="Consultar estado en Telegram"
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
                    tooltip="Eliminar webhook de Telegram"
                  >
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>¿Eliminar el webhook de {name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Se conservan los mensajes pendientes. Si has guardado el transporte Polling,
                      el asistente empezará a recibirlos por ese transporte; de lo contrario deja de
                      recibir mensajes hasta registrar otro webhook.
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
                          setNotice('Telegram ha confirmado la eliminación del webhook.');
                          setStatus(undefined);
                        })
                      }
                    >
                      Confirmar eliminación
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
          {status && (
            <div role="status">
              <p>
                {status.url
                  ? 'Webhook actual: ' + status.url
                  : 'Telegram no tiene un webhook registrado.'}
              </p>
              <p>Mensajes pendientes: {status.pending}</p>
              {status.lastError && <p>{status.lastError}</p>}
            </div>
          )}
        </>
      ) : (
        <p>Cargando conexión…</p>
      )}
    </details>
  );
}
