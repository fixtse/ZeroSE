'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  AudioLines,
  BookOpen,
  CalendarClock,
  Image,
  Map,
  RefreshCw,
  Save,
  Settings2,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useUrlState } from '../hooks/use-url-state';
import { SecretEditor } from './secret-editor';
import { ServiceSpeechPicker } from './service-speech-picker';
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
import { api } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Field, SelectField } from './settings-fields';
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
  general: 'General',
  media: 'Vídeo y voz',
  reader: 'Lectura de páginas',
  places: 'Mapas y rutas',
  braveApiKey: 'Búsqueda de imágenes',
  schedulerSE: 'SchedulerSE',
  codex: 'Codex',
};
const icons = {
  general: Settings2,
  media: AudioLines,
  reader: BookOpen,
  places: Map,
  braveApiKey: Image,
  schedulerSE: CalendarClock,
  codex: Terminal,
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
  morning: 'Resumen de la mañana',
  reset: 'Nueva sesión diaria',
  eventReminders: 'Recordatorios de eventos',
};
function fieldLabel(path: string) {
  const parts = path.split('.');
  if (path === 'schedules.enabled') return 'Horarios automáticos';
  const label = fieldNames[parts.at(-1)!] || parts.at(-1)!;
  return label;
}

function SecretField({
  field,
  cleared,
  onClear,
}: {
  field: ServiceField;
  cleared: boolean;
  onClear: () => void;
}) {
  const label = fieldLabel(field.path);
  return (
    <SecretEditor
      key={String(cleared)}
      id={'service-' + field.path}
      name={field.path}
      label={label}
      configured={field.configured && !cleared}
      hint={field.secretHint}
      preview={cleared ? 'Se eliminará al guardar' : undefined}
      disabled={field.readOnly}
      deleteAction={
        field.configured && !cleared ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="danger"
                size="icon-sm"
                tooltip={'Eliminar ' + label}
                disabled={field.readOnly}
              >
                <Trash2 />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>¿Eliminar {label.toLowerCase()}?</AlertDialogTitle>
                <AlertDialogDescription>
                  La credencial se eliminará al guardar los ajustes.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    onClear();
                  }}
                >
                  Eliminar
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : undefined
      }
    />
  );
}

function SettingsForm({
  settings,
  busy,
  scope,
  save,
  formId,
}: {
  settings: Settings;
  formId: string;
  busy: boolean;
  scope: 'services' | 'codex';
  save: (data: FormData, extra: Record<string, unknown>) => void;
}) {
  const [tab, setTab] = useUrlState(
    scope === 'codex' ? 'codexTab' : 'settingsTab',
    scope === 'codex' ? 'codex' : 'general',
  );
  const [cleared, setCleared] = useState<string[]>([]);
  const get = (path: string) =>
    String(settings.fields.find((field) => field.path === path)?.value ?? '');
  const [extraction, setExtraction] = useState(
    get('media.audioExtractionUrl') ? 'external' : 'internal',
  );
  const [tts, setTts] = useState(get('media.speech.tts') || 'default');
  const [stt, setStt] = useState(get('media.speech.stt') || 'default');
  const [voice, setVoice] = useState(get('media.voice'));
  const [language, setLanguage] = useState(() => {
    const match = /^([a-z]{2,3}-[A-Za-z0-9-]+)-[^-]+Neural$/.exec(get('media.voice'));
    return match?.[1] || '';
  });
  const groupFor = (field: ServiceField) =>
    ['timezone', 'concurrency', 'schedules'].includes(field.group) ? 'general' : field.group;
  const groups = [...new Set(settings.fields.map(groupFor))].sort((a, b) =>
    a === 'general' ? -1 : b === 'general' ? 1 : 0,
  );
  function renderField(field: ServiceField) {
    if (field.type === 'secret')
      return (
        <SecretField
          key={field.path}
          field={field}
          cleared={cleared.includes(field.path)}
          onClear={() => setCleared((current) => [...current, field.path])}
        />
      );
    const common = {
      id: 'service-' + field.path,
      name: field.path,
      label: fieldLabel(field.path),
      disabled: field.readOnly,
    };
    if (field.path === 'concurrency')
      return (
        <SelectField key={field.path} {...common} defaultValue={String(field.value)}>
          {Array.from({ length: 16 }, (_, index) => (
            <option key={index + 1} value={index + 1}>
              {index + 1}
            </option>
          ))}
        </SelectField>
      );
    if (field.type === 'boolean')
      return (
        <SelectField key={field.path} {...common} defaultValue={String(field.value)}>
          <option value="true">Activado</option>
          <option value="false">Desactivado</option>
        </SelectField>
      );
    if (field.type === 'list')
      return (
        <label key={field.path} className="service-list-field">
          {fieldLabel(field.path)} · un valor por línea
          <textarea
            name={field.path}
            readOnly={field.readOnly}
            defaultValue={(field.value as string[]).join('\n')}
          />
        </label>
      );
    return (
      <Field
        key={field.path}
        {...common}
        type={
          field.type === 'number'
            ? 'number'
            : ['schedules.morning', 'schedules.reset'].includes(field.path)
              ? 'time'
              : /Url$|\.url$/.test(field.path)
                ? 'url'
                : 'text'
        }
        list={field.path === 'timezone' ? 'service-timezone-options' : undefined}
        required={field.path === 'timezone'}
        autoComplete="off"
        defaultValue={String(field.value ?? '')}
      />
    );
  }
  const field = (path: string) => {
    const value = settings.fields.find((field) => field.path === path);
    return value ? renderField(value) : null;
  };
  return (
    <form
      id={formId}
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const invalid = event.currentTarget.querySelector<
          HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        >('input:invalid,select:invalid,textarea:invalid');
        if (invalid) {
          const panel = invalid.closest<HTMLElement>('[data-service-panel]');
          if (panel) setTab(panel.dataset.servicePanel!);
          requestAnimationFrame(() => invalid.reportValidity());
          return;
        }
        const extra: Record<string, unknown> = Object.fromEntries(
          cleared.map((path) => [path, null]),
        );
        if (scope === 'services') {
          extra['media.audioExtractionUrl'] =
            extraction === 'internal'
              ? ''
              : new FormData(event.currentTarget).get('media.audioExtractionUrl');
          extra['media.speech.tts'] = tts;
          extra['media.speech.stt'] = stt;
          if (tts === 'default') extra['media.voice'] = voice;
        }
        save(new FormData(event.currentTarget), extra);
      }}
    >
      <fieldset disabled={busy}>
        <Tabs
          value={groups.includes(tab) ? tab : groups[0]}
          onValueChange={setTab}
          className="provider-settings service-tabs"
        >
          <TabsList aria-label="Secciones de ajustes" className="provider-tabs-list">
            {groups.map((group) => {
              const Icon = icons[group as keyof typeof icons] || Settings2;
              return (
                <TabsTrigger key={group} value={group}>
                  <Icon aria-hidden="true" />
                  {names[group] || group}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {groups.map((group) => (
            <TabsContent
              key={group}
              value={group}
              forceMount
              className="service-panel"
              data-service-panel={group}
            >
              <h3>{names[group] || group}</h3>
              {group === 'media' ? (
                <>
                  <div className="settings-grid">
                    <SelectField
                      id="service-extraction"
                      label="Extracción de audio de vídeos"
                      value={extraction}
                      onChange={(event) => setExtraction(event.target.value)}
                    >
                      <option value="internal">FFmpeg interno</option>
                      <option value="external">Servicio externo</option>
                    </SelectField>
                    {extraction === 'external' && (
                      <Field
                        id="service-media.audioExtractionUrl"
                        name="media.audioExtractionUrl"
                        label="URL del servicio de extracción de audio"
                        type="url"
                        required
                        defaultValue={get('media.audioExtractionUrl')}
                      />
                    )}
                  </div>
                  <div className="settings-grid">
                    <SelectField
                      id="service-tts"
                      label="Síntesis de voz"
                      value={tts}
                      onChange={(event) => setTts(event.target.value)}
                    >
                      <option value="default">Edge TTS</option>
                      {get('media.speech.tts') && get('media.speech.tts') !== 'default' && (
                        <option value={get('media.speech.tts')}>
                          Home Assistant · {get('media.speech.tts')}
                        </option>
                      )}
                    </SelectField>
                    {tts === 'default' && (
                      <>
                        <ServiceSpeechPicker
                          kind="languages"
                          label="Filtrar voces por idioma"
                          value={language}
                          onChange={setLanguage}
                        />
                        <ServiceSpeechPicker
                          kind="voices"
                          label="Voz"
                          value={voice}
                          language={language}
                          onChange={setVoice}
                        />
                      </>
                    )}
                  </div>
                  <div className="settings-grid">
                    <SelectField
                      id="service-stt"
                      label="Transcripción de audio"
                      value={stt}
                      onChange={(event) => setStt(event.target.value)}
                    >
                      <option value="default">Servicio externo</option>
                      {get('media.speech.stt') && get('media.speech.stt') !== 'default' && (
                        <option value={get('media.speech.stt')}>
                          Home Assistant · {get('media.speech.stt')}
                        </option>
                      )}
                    </SelectField>
                    {stt === 'default' && field('media.asrUrl')}
                  </div>
                  <details className="service-advanced">
                    <summary>Opciones avanzadas</summary>
                    <div className="settings-grid">
                      {field('media.maxBytes')}
                      {tts !== 'default' &&
                        ['media.speech.ttsLanguage', 'media.speech.voice'].map(field)}
                      {stt !== 'default' && field('media.speech.sttLanguage')}
                    </div>
                  </details>
                </>
              ) : (
                <div className="settings-grid">
                  {settings.fields.filter((field) => groupFor(field) === group).map(renderField)}
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
        <TimezoneOptions id="service-timezone-options" />
      </fieldset>
    </form>
  );
}

export function ServiceSettings({
  onSkip,
  scope = 'services',
}: {
  onSkip: () => void;
  scope?: 'services' | 'codex';
}) {
  const formId = useId();
  const [settings, setSettings] = useState<Settings>();
  const { busy, run, setNotice } = useAdminTask();
  const endpoint = '/v1/admin/setup/' + scope;
  async function load() {
    setSettings(await api<Settings>(endpoint));
  }
  useEffect(() => {
    void run(load);
  }, []);
  function save(data: FormData, extra: Record<string, unknown>) {
    void run(async () => {
      const changes: Record<string, unknown> = {};
      for (const field of settings!.fields) {
        if (field.readOnly || !data.has(field.path)) continue;
        if (field.type === 'secret') {
          if (data.get(field.path)) changes[field.path] = String(data.get(field.path));
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
                    .map((value) => value.trim())
                    .filter(Boolean)
                : raw;
        if (JSON.stringify(value) !== JSON.stringify(field.value)) changes[field.path] = value;
      }
      for (const [path, value] of Object.entries(extra)) {
        if (
          data.get(path) &&
          settings!.fields.find((field) => field.path === path)?.type === 'secret'
        )
          continue;
        if (
          JSON.stringify(value) !==
          JSON.stringify(settings!.fields.find((field) => field.path === path)?.value)
        )
          changes[path] = value;
      }
      await api(endpoint, 'PUT', { revision: settings!.revision, changes });
      await load();
      setNotice(scope === 'codex' ? 'Parámetros CLI guardados.' : 'Ajustes guardados y aplicados.');
    });
  }
  return (
    <section className="service-settings">
      <div className="service-settings-heading">
        <h2>{scope === 'codex' ? 'Parámetros CLI' : 'Ajustes'}</h2>
        <div className="action-group">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            size="icon"
            tooltip="Recargar ajustes"
            onClick={() => void run(load)}
          >
            <RefreshCw />
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={busy || !settings}
            size="icon"
            tooltip={scope === 'codex' ? 'Guardar parámetros CLI' : 'Guardar ajustes'}
          >
            <Save />
          </Button>
          {scope === 'codex' && (
            <Button type="button" variant="ghost" size="icon" tooltip="Cerrar" onClick={onSkip}>
              <X />
            </Button>
          )}
        </div>
      </div>
      {settings ? (
        <SettingsForm
          key={settings.revision}
          settings={settings}
          formId={formId}
          busy={busy}
          scope={scope}
          save={save}
        />
      ) : (
        <p>Cargando ajustes…</p>
      )}
    </section>
  );
}
