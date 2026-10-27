'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Field, SelectField, CheckField } from './settings-fields';
import { TimezoneOptions } from './timezone-options';
interface ServiceField {
  path: string;
  group: string;
  type: string;
  value: unknown;
  configured: boolean;
  secretHint?: string;
  readOnly: boolean;
}
interface Settings {
  revision: number;
  fields: ServiceField[];
}
const names: Record<string, string> = {
  media: 'Vídeo, FFmpeg y voz',
  reader: 'Lectura de páginas · Jina',
  places: 'Mapas y rutas',
  braveApiKey: 'Búsqueda de imágenes · Brave',
  schedulerSE: 'SchedulerSE',
  schedules: 'Horarios',
  codex: 'Codex',
  timezone: 'Zona horaria',
  concurrency: 'Concurrencia',
};
const fieldNames: Record<string, string> = {
  timezone: 'Zona horaria',
  concurrency: 'Conversaciones simultáneas',
  command: 'Ejecutable de Codex',
  args: 'Argumentos de Codex',
  home: 'Directorio de sesión de Codex',
  timeoutMs: 'Tiempo máximo de respuesta (ms)',
  url: 'URL del servicio',
  apiKey: 'Clave API',
  token: 'Token de acceso',
  callbackUrl: 'URL de entrega de eventos',
  enabled: 'Activado',
  ffmpegCommand: 'Ejecutable de FFmpeg',
  asrUrl: 'URL de transcripción de audio',
  audioExtractionUrl: 'URL del servicio de extracción de audio de vídeos',
  voice: 'Voz',
  maxBytes: 'Tamaño máximo de archivos (bytes)',
  stt: 'Motor de reconocimiento de voz',
  sttLanguage: 'Idioma de reconocimiento',
  tts: 'Motor de síntesis de voz',
  ttsLanguage: 'Idioma de síntesis',
  photonUrl: 'URL de geocodificación Photon',
  osrmUrl: 'URL de rutas OSRM',
  braveApiKey: 'Clave API de Brave',
  morning: 'Resumen de la mañana (HH:MM)',
  reset: 'Reinicio diario (HH:MM)',
  eventReminders: 'Recordatorios de eventos',
};
function fieldLabel(path: string) {
  const parts = path.split('.');
  const label = fieldNames[parts.at(-1)!] || parts.at(-1)!;
  return label;
}
export function ServiceSettings({
  onSkip,
  scope = 'services',
}: {
  onSkip: () => void;
  scope?: 'services' | 'codex';
}) {
  const [settings, setSettings] = useState<Settings>();
  const { busy, run, setNotice } = useAdminTask();
  const endpoint = '/v1/admin/setup/' + scope;
  async function load() {
    setSettings(await api<Settings>(endpoint));
  }
  useEffect(() => {
    void run(load);
  }, []);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      const changes: Record<string, unknown> = {};
      for (const field of settings!.fields) {
        if (field.readOnly) continue;
        if (field.type === 'secret') {
          if (data.has('clear:' + field.path)) changes[field.path] = null;
          else if (data.get(field.path)) changes[field.path] = String(data.get(field.path));
          continue;
        }
        const raw = String(data.get(field.path) ?? '');
        const value =
          field.type === 'number'
            ? Number(raw)
            : field.type === 'boolean'
              ? raw === 'true'
              : field.type === 'list'
                ? raw
                    .split('\n')
                    .map((x) => x.trim())
                    .filter(Boolean)
                : raw;
        if (JSON.stringify(value) !== JSON.stringify(field.value)) changes[field.path] = value;
      }
      await api(endpoint, 'PUT', { revision: settings!.revision, changes });
      await load();
      setNotice('Ajustes guardados. Reinicia Zero de forma explícita para aplicar los cambios.');
    });
  }
  const groups = [...new Set(settings?.fields.map((field) => field.group) ?? [])];
  return (
    <section className="service-settings">
      {scope === 'services' && <h2>Configuración de servicios</h2>}
      <p>
        {scope === 'codex'
          ? 'Parámetros de la sesión CLI compartida por las conexiones Codex. El modelo y el esfuerzo se configuran en Modelos.'
          : 'Configura los servicios comunes de Zero. Gestiona la IA en Proveedores IA, Telegram en cada asistente y las conexiones de Google y Home Assistant en cada usuario.'}
      </p>
      <p>
        Los ajustes se guardan cifrados en la base de datos y requieren un reinicio explícito de
        Zero para aplicarse.
      </p>
      {settings ? (
        <form key={settings.revision} onSubmit={save}>
          <fieldset disabled={busy}>
            <Tabs defaultValue={groups[0]} className="provider-settings service-tabs">
              <TabsList aria-label="Secciones de servicios" className="provider-tabs-list">
                {groups.map((group) => (
                  <TabsTrigger key={group} value={group}>
                    {names[group] || group}
                  </TabsTrigger>
                ))}
              </TabsList>
              {groups.map((group) => (
                <TabsContent key={group} value={group} forceMount className="service-panel">
                  <h3>{names[group] || group}</h3>
                  {settings.fields
                    .filter((field) => field.group === group)
                    .map((field) => (
                      <div key={field.path}>
                        {field.type === 'boolean' ? (
                          <SelectField
                            id={'service-' + field.path}
                            name={field.path}
                            label={fieldLabel(field.path)}
                            defaultValue={String(field.value)}
                            disabled={field.readOnly}
                          >
                            <option value="true">Activado</option>
                            <option value="false">Desactivado</option>
                          </SelectField>
                        ) : field.type === 'list' ? (
                          <label className="service-list-field">
                            {fieldLabel(field.path)} · un valor por línea
                            <textarea
                              name={field.path}
                              readOnly={field.readOnly}
                              defaultValue={(field.value as string[]).join('\n')}
                            />
                          </label>
                        ) : (
                          <Field
                            id={'service-' + field.path}
                            name={field.path}
                            label={fieldLabel(field.path)}
                            type={
                              field.type === 'secret'
                                ? 'password'
                                : field.type === 'number'
                                  ? 'number'
                                  : 'text'
                            }
                            list={
                              field.path === 'timezone' ? 'service-timezone-options' : undefined
                            }
                            required={field.path === 'timezone'}
                            autoComplete="off"
                            readOnly={field.readOnly}
                            defaultValue={String(field.value ?? '')}
                            placeholder={field.secretHint || (field.configured ? '••••••••' : '')}
                          />
                        )}
                        {field.type === 'secret' && (
                          <CheckField
                            id={'clear-service-' + field.path}
                            name={'clear:' + field.path}
                            label="Borrar secreto guardado"
                            disabled={field.readOnly}
                          />
                        )}
                      </div>
                    ))}
                </TabsContent>
              ))}
            </Tabs>
            <TimezoneOptions id="service-timezone-options" />
            <div className="form-actions">
              <Button disabled={busy}>
                {scope === 'codex' ? 'Guardar parámetros CLI' : 'Guardar servicios'}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={onSkip}>
                {scope === 'codex' ? 'Cerrar' : 'Configurar más adelante'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void run(load)}
              >
                Recargar
              </Button>
            </div>
          </fieldset>
        </form>
      ) : (
        <p>Cargando servicios…</p>
      )}
    </section>
  );
}
