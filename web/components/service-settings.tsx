'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Home, AudioLines, BookOpen, Search, Map, Save, Settings2, Trash2 } from 'lucide-react';
import { useUrlState } from '../hooks/use-url-state';
import { HomeAssistantAccess } from './home-assistant-access';
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
import { Switch } from './ui/switch';
import { Label } from './ui/label';
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
  homeAssistant: 'Home Assistant',
  general: 'General',
  media: 'Vídeo y voz',
  reader: 'Jina AI',
  places: 'Mapas y rutas',
  braveApiKey: 'Brave Search',
};
const icons = {
  homeAssistant: Home,
  general: Settings2,
  media: AudioLines,
  reader: BookOpen,
  places: Map,
  braveApiKey: Search,
};
const fieldNames: Record<string, string> = {
  connectionUrl: 'URL de conexión pública',
  timezone: 'Zona horaria',
  concurrency: 'Conversaciones simultáneas',
  url: 'URL del servicio',
  apiKey: 'Clave API',
  token: 'Token de acceso',
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
};
function fieldLabel(path: string) {
  const parts = path.split('.');
  const label = fieldNames[parts.at(-1)!] || parts.at(-1)!;
  return label;
}

function BooleanField({ field }: { field: ServiceField }) {
  const [checked, setChecked] = useState(field.value === true);
  const id = 'service-' + field.path;
  return (
    <div className="service-switch-field">
      <Label htmlFor={id}>{fieldLabel(field.path)}</Label>
      <Switch id={id} checked={checked} onCheckedChange={setChecked} disabled={field.readOnly} />
      <input type="hidden" name={field.path} value={String(checked)} disabled={field.readOnly} />
    </div>
  );
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
  save,
  formId,
  reload,
  tab,
  setTab,
}: {
  settings: Settings;
  tab: string;
  setTab: (value: string) => void;
  reload: () => Promise<void>;
  formId: string;
  busy: boolean;
  save: (data: FormData, extra: Record<string, unknown>) => void;
}) {
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
    ['connectionUrl', 'timezone', 'concurrency'].includes(field.group) ? 'general' : field.group;
  const groups = [...new Set([...settings.fields.map(groupFor), 'homeAssistant'])].sort((a, b) =>
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
    if (field.type === 'boolean') return <BooleanField key={field.path} field={field} />;
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
        type={field.type === 'number' ? 'number' : /Url$|\.url$/.test(field.path) ? 'url' : 'text'}
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
        extra['media.audioExtractionUrl'] =
          extraction === 'internal'
            ? ''
            : new FormData(event.currentTarget).get('media.audioExtractionUrl');
        extra['media.speech.tts'] = tts;
        extra['media.speech.stt'] = stt;
        if (tts === 'default') extra['media.voice'] = voice;
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
              {group === 'braveApiKey' && <p>Búsqueda web e imágenes con la misma clave.</p>}
              {group === 'general' && (
                <p>
                  La URL pública de Zero se usa para Telegram, Google y otros servicios. Si está
                  vacía, Home Assistant puede configurarla al integrar su relay HTTPS; mientras
                  tanto se usa la dirección del administrador. Cambiarla no registra de nuevo los
                  webhooks existentes.
                </p>
              )}
              {group === 'homeAssistant' ? (
                <HomeAssistantAccess />
              ) : group === 'media' ? (
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

export function ServiceSettings() {
  const formId = useId();
  const [activeTab, setActiveTab] = useUrlState('settingsTab', 'general');
  const [settings, setSettings] = useState<Settings>();
  const { busy, run, setNotice } = useAdminTask();
  const endpoint = '/v1/admin/setup/services';
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
      setNotice('Ajustes guardados y aplicados.');
    });
  }
  return (
    <section className="service-settings">
      <div className="service-settings-heading">
        <h2>Ajustes</h2>
        <div className="action-group">
          {activeTab !== 'homeAssistant' && (
            <Button
              type="submit"
              form={formId}
              disabled={busy || !settings}
              size="icon"
              tooltip="Guardar ajustes"
            >
              <Save />
            </Button>
          )}
        </div>
      </div>
      {settings ? (
        <SettingsForm
          key={settings.revision}
          settings={settings}
          tab={activeTab}
          setTab={setActiveTab}
          formId={formId}
          busy={busy}
          save={save}
          reload={load}
        />
      ) : (
        <p>Cargando ajustes…</p>
      )}
    </section>
  );
}
