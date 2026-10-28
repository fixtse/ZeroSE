'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Link2, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface Pairing {
  state: string;
  serviceUrl?: string;
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
  const [browserUrl, setBrowserUrl] = useState('');
  const [pairing, setPairing] = useState<Pairing>();
  const { busy, run, setNotice } = useAdminTask();
  const active = pairing && !['idle', 'expired', 'revoked', 'configured'].includes(pairing.state);
  function beginPairing() {
    void run(async () => {
      // Reserve the tab during the click so browsers allow it before the request completes.
      const approvalTab = window.open('about:blank', '_blank');
      if (approvalTab) approvalTab.opener = null;
      try {
        const value = await api<Pairing>(endpoint, 'POST', {
          url: url.trim(),
          ...(browserUrl.trim() ? { browserUrl: browserUrl.trim() } : {}),
        });
        setPairing(value);
        if (value.approvalUrl && approvalTab && !approvalTab.closed) {
          approvalTab.location.replace(value.approvalUrl);
        } else {
          approvalTab?.close();
        }
      } catch (error) {
        approvalTab?.close();
        throw error;
      }
    });
  }
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
        HTTP se admite solo en una red privada de confianza, sin cifrado. Para destinos públicos,
        usa HTTPS. SchedulerSE debe poder acceder a la dirección pública configurada en Zero. Guarda
        antes cualquier otro ajuste pendiente.
      </p>
      {!active ? (
        <div className="scheduler-pairing-field">
          <Label htmlFor="scheduler-pairing-url">URL de SchedulerSE</Label>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              id="scheduler-pairing-url"
              type="url"
              className="h-10 flex-1"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://scheduler.example.com"
            />
            <Button
              type="button"
              size="icon-lg"
              tooltip="Iniciar conexión con SchedulerSE"
              disabled={busy || !url.trim()}
              onClick={beginPairing}
            >
              <Link2 />
            </Button>
            <Button
              type="button"
              size="icon-lg"
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
          <details className="mt-3 space-y-2">
            <summary className="cursor-pointer text-sm">Acceso desde el navegador</summary>
            <Label htmlFor="scheduler-browser-url">
              URL de SchedulerSE para aprobar (opcional)
            </Label>
            <Input
              id="scheduler-browser-url"
              type="url"
              value={browserUrl}
              onChange={(event) => setBrowserUrl(event.target.value)}
              placeholder="http://localhost:3000"
              aria-describedby="scheduler-browser-help"
            />
            <p id="scheduler-browser-help" className="text-sm text-muted-foreground">
              Si usas un nombre interno de Docker, indica aquí la dirección accesible desde tu
              navegador, por ejemplo mediante un túnel SSH. Solo se usa para abrir la aprobación; la
              conexión de Zero utiliza la URL anterior.
            </p>
          </details>
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
          <p role="status" className="text-sm text-muted-foreground">
            {pairing.state === 'uncertain' || pairing.state === 'saving'
              ? 'El guardado no está confirmado. Comprueba el estado; la escritura no se repetirá.'
              : 'Abre SchedulerSE, revisa los permisos y aprueba la solicitud. Después comprueba la aprobación aquí.'}
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
