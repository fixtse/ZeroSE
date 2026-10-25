'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Field, CheckField } from './settings-fields';
interface BotStatus {
  id: 'zero' | 'salem';
  configured: boolean;
  enabled: boolean;
  webhookUrl?: string;
}
interface WebhookStatus {
  url: string;
  expectedUrl: string;
  registered: boolean;
  pending: number;
  lastError?: string;
}
export function BotSettings() {
  const { busy, notice, setNotice, run } = useAdminTask();
  const [bots, setBots] = useState<BotStatus[]>([]),
    [webhook, setWebhook] = useState<WebhookStatus>();
  const [revision, setRevision] = useState(0);
  async function load() {
    setBots((await api<{ items: BotStatus[] }>('/v1/admin/bots')).items);
  }
  useEffect(() => {
    void run(load);
  }, []);
  const salem = bots.find((bot) => bot.id === 'salem'),
    zero = bots.find((bot) => bot.id === 'zero');
  return (
    <Card className="panel">
      <h2>Conexiones de Telegram</h2>
      <p>
        La personalidad de cada asistente se configura en Asistentes. Estas conexiones controlan la
        entrega de mensajes de Zero y Salem.
      </p>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <div className="profile-row">
        <strong>Zero</strong>
        <Badge variant="outline">
          {zero?.enabled ? 'Activo' : zero?.configured ? 'Configurado' : 'Sin configurar'}
        </Badge>
        <small>Usa la conexión del servidor.</small>
      </div>
      {salem ? (
        <form
          key={revision}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void run(async () => {
              const value = await api<{ saved: boolean; webhookRegistered: boolean }>(
                '/v1/admin/bots/salem',
                'PUT',
                {
                  token: String(data.get('token') || '').trim(),
                  webhookUrl: String(data.get('webhookUrl') || '').trim(),
                  enabled: data.has('enabled'),
                },
              );
              setWebhook(undefined);
              await load();
              setRevision((v) => v + 1);
              setNotice(
                value.webhookRegistered
                  ? 'Conexión guardada y webhook confirmado.'
                  : 'Conexión guardada.',
              );
            });
          }}
        >
          <h3>Salem</h3>
          <Field
            id="salem-bot-token"
            name="token"
            label="Token del bot de Telegram"
            type="password"
            autoComplete="off"
            maxLength={300}
            placeholder={salem.configured ? 'Vacío conserva el token guardado' : '123456:token'}
          />
          <Field
            id="salem-webhook-url"
            name="webhookUrl"
            label="URL pública del webhook"
            type="url"
            maxLength={2048}
            defaultValue={salem.webhookUrl || ''}
            placeholder="https://zero.example/telegram/salem/webhook"
          />
          <CheckField
            id="salem-bot-enabled"
            name="enabled"
            label="Activar respuestas de Salem"
            defaultChecked={salem.enabled}
          />
          <small>
            Guardar una conexión activada registra el webhook una vez. Los resultados inciertos no
            se reintentan automáticamente.
          </small>
          <div className="form-actions">
            <Button disabled={busy}>Guardar conexión de Salem</Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !salem.configured}
              onClick={() =>
                void run(async () => setWebhook(await api('/v1/admin/bots/salem/webhook')))
              }
            >
              Consultar estado del webhook
            </Button>
          </div>
        </form>
      ) : (
        <p>Cargando conexiones…</p>
      )}
      {webhook && (
        <div className="catalog-row" role="status">
          <strong>{webhook.registered ? 'Webhook registrado' : 'Webhook sin confirmar'}</strong>
          <p>URL: {webhook.url || 'Sin registrar'}</p>
          <p>Esperada: {webhook.expectedUrl}</p>
          <small>
            {webhook.pending} actualizaciones pendientes
            {webhook.lastError ? ' · ' + webhook.lastError : ''}
          </small>
        </div>
      )}
    </Card>
  );
}
