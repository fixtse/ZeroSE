'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Link2, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Field } from './settings-fields';

interface Pairing {
  state: string;
  serviceUrl?: string;
  callbackUrl?: string;
  approvalUrl?: string;
  expiresAt?: string;
}
const endpoint = '/v1/admin/setup/services/schedulerse/pairing';
export function SchedulerSEPairing({
  configured,
  tokenHint,
  onSaved,
}: {
  configured: boolean;
  tokenHint?: string;
  onSaved: () => Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [pairing, setPairing] = useState<Pairing>();
  const { busy, run, setNotice } = useAdminTask();
  const active = pairing && !['idle', 'expired', 'revoked', 'configured'].includes(pairing.state);
  async function inspect() {
    const value = await api<Pairing>(endpoint);
    setPairing(value);
    if (value.state === 'configured') await onSaved();
    return value;
  }
  useEffect(() => {
    void run(async () => {
      await inspect();
    });
  }, []);
  if (configured)
    return (
      <p role="status">
        Credencial de SchedulerSE guardada: {tokenHint || '••••••••'}. La conexión actual se
        conserva.
      </p>
    );
  return (
    <div className="space-y-4">
      <p>
        Conecta Zero con la URL de SchedulerSE y aprueba el acceso allí. Las credenciales se guardan
        automáticamente.
      </p>
      <p className="text-sm text-muted-foreground">
        Usa HTTPS en la red local. Zero debe ser accesible desde SchedulerSE mediante la dirección
        pública configurada en Zero. Guarda antes cualquier otro ajuste pendiente.
      </p>
      {!active ? (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field
              id="scheduler-pairing-url"
              label="URL de SchedulerSE"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://scheduler.example.com"
            />
          </div>
          <Button
            type="button"
            size="icon"
            tooltip="Iniciar conexión con SchedulerSE"
            disabled={busy || !url.trim()}
            onClick={() =>
              void run(async () => {
                setPairing(await api<Pairing>(endpoint, 'POST', { url: url.trim() }));
              })
            }
          >
            <Link2 />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            tooltip="Recuperar estado de la conexión"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await inspect();
              })
            }
          >
            <RefreshCw />
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 break-all">{pairing.serviceUrl}</span>
            <div className="action-group">
              {pairing.approvalUrl && (
                <Button
                  asChild
                  size="icon"
                  variant="outline"
                  tooltip="Autorizar conexión en SchedulerSE"
                >
                  <a href={pairing.approvalUrl} target="_blank" rel="noopener noreferrer">
                    <ArrowUpRight />
                  </a>
                </Button>
              )}
              <Button
                type="button"
                size="icon"
                tooltip="Comprobar aprobación y guardar conexión"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const value = await inspect();
                    if (value.state === 'approved') {
                      await api(endpoint + '/finish', 'POST', {});
                      await inspect();
                      setNotice('SchedulerSE conectado. Credenciales guardadas.');
                    } else if (value.state === 'pending')
                      setNotice('La solicitud sigue pendiente de aprobación en SchedulerSE.');
                  })
                }
              >
                <RefreshCw />
              </Button>
            </div>
          </div>
          <p className="break-all text-sm">Entrega de eventos: {pairing.callbackUrl}</p>
          <p role="status" className="text-sm text-muted-foreground">
            {pairing.state === 'uncertain' || pairing.state === 'saving'
              ? 'El guardado no está confirmado. Comprueba el estado; la escritura no se repetirá.'
              : 'Abre SchedulerSE, revisa la dirección de entrega y aprueba la solicitud. Después comprueba la aprobación aquí.'}
          </p>
          {pairing.expiresAt && (
            <p className="text-sm text-muted-foreground">
              Caduca: {new Date(pairing.expiresAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      )}
      {pairing?.state === 'expired' && (
        <p role="status">La solicitud ha caducado. Puedes iniciar una nueva conexión.</p>
      )}
      {pairing?.state === 'revoked' && (
        <p role="status">La solicitud se ha denegado o revocado en SchedulerSE.</p>
      )}
    </div>
  );
}
