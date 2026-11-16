'use client';
import { useTranslations } from '../i18n/provider';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Home, AudioLines, BookOpen, Search, Map, Save, Settings2, Trash2 } from 'lucide-react';
import { useUrlState } from '../hooks/use-url-state';
import { HomeAssistantAccess } from './home-assistant-access';
import { SecretEditor } from './secret-editor';
import { ServiceSpeechPicker } from './service-speech-picker';
import { SpeechLanguagePicker } from './speech-language-picker';
import { whisperLanguages } from '../lib/whisper-languages';
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
  inherited?: boolean;
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
  search: 'Búsqueda web e imágenes',
};
const icons = {
  homeAssistant: Home,
  general: Settings2,
  media: AudioLines,
  reader: BookOpen,
  places: Map,
  search: Search,
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
  asrUrls: 'Fuentes adicionales de ClipSE Whisper',
  asrModel: 'Modelo Whisper',
  asrWhisperProvider: 'Motor Whisper',
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
  defaultProvider: 'Proveedor de imágenes predeterminado',
  searchApiKey: 'Clave API de SearchAPI',
  serpApiKey: 'Clave API de SerpApi',
};
function fieldLabel(path: string) {
  const parts = path.split('.');
  const label = fieldNames[parts.at(-1)!] || parts.at(-1)!;
  return label;
}

function BooleanField({ field }: { field: ServiceField }) {
  const t = useTranslations();
  const [checked, setChecked] = useState(field.value === true);
  const id = 'service-' + field.path;
  return (
    <div className="service-switch-field">
      <Label htmlFor={id}>{t(fieldLabel(field.path))}</Label>
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
  const t = useTranslations();
  const label = t(fieldLabel(field.path));
  return (
    <SecretEditor
      key={String(cleared)}
      id={'service-' + field.path}
      name={field.path}
      label={label}
      configured={field.configured && !cleared}
      hint={field.secretHint}
      preview={cleared ? t('Se eliminará al guardar') : undefined}
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
                tooltip={t('Eliminar ') + label}
                disabled={field.readOnly}
              >
                <Trash2 />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('¿Eliminar')} {label.toLowerCase()}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('La credencial se eliminará al guardar los ajustes.')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('Cancelar')}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    onClear();
                  }}
                >
                  {t('Eliminar')}
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
  const t = useTranslations();
  const [cleared, setCleared] = useState<string[]>([]);
  const get = (path: string) =>
    String(settings.fields.find((field) => field.path === path)?.value ?? '');
  const [extraction, setExtraction] = useState(
    get('media.audioExtractionUrl') ? 'external' : 'internal',
  );
  const [tts, setTts] = useState(get('media.speech.tts') || 'default');
  const [stt, setStt] = useState(
    get('media.speech.stt') && get('media.speech.stt') !== 'default'
      ? get('media.speech.stt')
      : get('media.asrProvider') === 'clipse-whisper'
        ? 'clipse-whisper'
        : get('media.asrProvider') === 'none' ||
            (!get('media.asrUrl') &&
              !settings.fields.find((f) => f.path === 'media.asrUrl')?.configured)
          ? 'none'
          : 'default',
  );
  const [whisperProvider, setWhisperProvider] = useState(get('media.asrWhisperProvider'));
  const [whisperModel, setWhisperModel] = useState(get('media.asrModel'));
  const [sttLanguage, setSttLanguage] = useState(get('media.speech.sttLanguage'));
  const whisperModels = [
    ...(whisperProvider === 'faster-whisper' ? ['small', 'medium', 'large-v3-turbo'] : []),
    ...(whisperProvider === 'hailo' ? ['whisper-tiny', 'whisper-base', 'whisper-small'] : []),
  ];
  const [voice, setVoice] = useState(get('media.voice'));
  const [language, setLanguage] = useState(() => {
    const match = /^([a-z]{2,3}-[A-Za-z0-9-]+)-[^-]+Neural$/.exec(get('media.voice'));
    return match?.[1] || '';
  });
  const groupFor = (field: ServiceField) =>
    ['connectionUrl', 'timezone', 'concurrency'].includes(field.group)
      ? 'general'
      : ['braveApiKey', 'imageSearch'].includes(field.group)
        ? 'search'
        : field.group;
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
      label: t(fieldLabel(field.path)),
      disabled: field.readOnly,
    };
    if (field.path === 'imageSearch.defaultProvider')
      return (
        <SelectField key={field.path} {...common} defaultValue={String(field.value)}>
          <option value="brave">Brave Search</option>
          <option value="searchapi">SearchAPI · Google Images</option>
          <option value="serpapi">SerpApi · Google Images</option>
        </SelectField>
      );
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
          {t(fieldLabel(field.path))} {t('· un valor por línea')}
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
        extra['media.speech.stt'] = ['clipse-whisper', 'none'].includes(stt) ? 'default' : stt;
        if (['default', 'clipse-whisper', 'none'].includes(stt)) {
          extra['media.asrProvider'] =
            stt === 'clipse-whisper' ? 'clipse-whisper' : stt === 'none' ? 'none' : 'legacy';
        }
        if (stt === 'clipse-whisper') {
          extra['media.asrWhisperProvider'] = whisperProvider;
          extra['media.asrModel'] = whisperModels.includes(whisperModel) ? whisperModel : '';
        }
        if (tts === 'default') extra['media.voice'] = voice;
        save(new FormData(event.currentTarget), extra);
      }}
    >
      <fieldset disabled={busy}>
        <Tabs
          value={
            ['braveApiKey', 'imageSearch'].includes(tab)
              ? 'search'
              : groups.includes(tab)
                ? tab
                : groups[0]
          }
          onValueChange={setTab}
          className="provider-settings service-tabs"
        >
          <TabsList aria-label={t('Secciones de ajustes')} className="provider-tabs-list">
            {groups.map((group) => {
              const Icon = icons[group as keyof typeof icons] || Settings2;
              return (
                <TabsTrigger key={group} value={group}>
                  <Icon aria-hidden="true" />
                  {t(names[group] || group)}
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
              <h3>{t(names[group] || group)}</h3>
              {group === 'search' && (
                <p>
                  {t(
                    'Brave mantiene la búsqueda web. Para imágenes, configura una o varias claves y elige el proveedor predeterminado. Zero puede elegir otro proveedor configurado en cada búsqueda; los errores no cambian de proveedor automáticamente.',
                  )}
                </p>
              )}
              {group === 'general' && (
                <p>
                  {t(
                    'La URL pública de Zero se usa para Telegram, Google y otros servicios. Si está sin configurar, se usa la dirección del servidor. Home Assistant puede añadir su relay HTTPS si no hay una dirección pública configurada. Cambiarla no registra de nuevo los webhooks existentes.',
                  )}
                </p>
              )}
              {group === 'general' &&
                settings.fields.find((field) => field.path === 'connectionUrl')?.inherited && (
                  <p>
                    {t(
                      'La URL mostrada procede de la configuración del servidor. Puedes guardar otra dirección para sustituirla; dejar el campo vacío vuelve a usar la del servidor.',
                    )}
                  </p>
                )}
              {group === 'homeAssistant' ? (
                <HomeAssistantAccess />
              ) : group === 'media' ? (
                <>
                  <div className="settings-grid">
                    <SelectField
                      id="service-extraction"
                      label={t('Extracción de audio de vídeos')}
                      value={extraction}
                      onChange={(event) => setExtraction(event.target.value)}
                    >
                      <option value="internal">{t('FFmpeg interno')}</option>
                      <option value="external">{t('Servicio externo')}</option>
                    </SelectField>
                    {extraction === 'external' && (
                      <Field
                        id="service-media.audioExtractionUrl"
                        name="media.audioExtractionUrl"
                        label={t('URL del servicio de extracción de audio')}
                        type="url"
                        required
                        defaultValue={get('media.audioExtractionUrl')}
                      />
                    )}
                  </div>
                  <div className="settings-grid">
                    <SelectField
                      id="service-tts"
                      label={t('Síntesis de voz')}
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
                          label={t('Filtrar voces por idioma')}
                          value={language}
                          onChange={setLanguage}
                        />
                        <ServiceSpeechPicker
                          kind="voices"
                          label={t('Voz')}
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
                      label={t('Transcripción de audio')}
                      value={stt}
                      onChange={(event) => setStt(event.target.value)}
                    >
                      <option value="none">{t('Sin transcripción')}</option>
                      <option value="clipse-whisper">ClipSE Whisper</option>
                      <option value="default">{t('Servicio compatible (audio_file)')}</option>
                      {get('media.speech.stt') && get('media.speech.stt') !== 'default' && (
                        <option value={get('media.speech.stt')}>
                          Home Assistant · {get('media.speech.stt')}
                        </option>
                      )}
                    </SelectField>
                    {(stt === 'default' || stt === 'clipse-whisper') && field('media.asrUrl')}
                    {stt === 'clipse-whisper' && field('media.asrUrls')}
                    {stt === 'clipse-whisper' && (
                      <>
                        <SelectField
                          id="service-whisper-provider"
                          label={t('Motor Whisper')}
                          value={whisperProvider}
                          onChange={(event) => {
                            setWhisperProvider(event.target.value);
                            setWhisperModel('');
                          }}
                        >
                          <option value="">{t('Predeterminado del servicio')}</option>
                          <option value="faster-whisper">Faster Whisper</option>
                          <option value="hailo">Hailo</option>
                        </SelectField>
                        <SelectField
                          id="service-whisper-model"
                          label={t('Modelo Whisper')}
                          value={whisperModels.includes(whisperModel) ? whisperModel : ''}
                          disabled={!whisperProvider}
                          onChange={(event) => setWhisperModel(event.target.value)}
                        >
                          <option value="">{t('Predeterminado del servicio')}</option>
                          {whisperModels.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </SelectField>
                        <SpeechLanguagePicker
                          id="service-stt-language"
                          name="media.speech.sttLanguage"
                          label={t('Idioma de reconocimiento')}
                          value={sttLanguage}
                          languages={whisperLanguages}
                          useDefaultLanguages={false}
                          allowAutomatic
                          disabled={busy}
                          onChange={setSttLanguage}
                        />
                      </>
                    )}
                  </div>
                  {stt === 'clipse-whisper' && (
                    <p>
                      {t(
                        'Usa la URL completa de /transcribe. Selecciona un motor Whisper para elegir su modelo. El idioma se puede detectar automáticamente.',
                      )}{' '}
                      {t(
                        'Añade más servidores ClipSE Whisper para repartir la carga: Zero los usa por turnos y, si uno falla, prueba el siguiente.',
                      )}
                    </p>
                  )}
                  {stt === 'none' && (
                    <p>
                      {t(
                        'Zero no transcribirá audios ni vídeos y avisará en el chat. Puedes asignar un motor de Home Assistant a cada perfil en su pestaña de voz.',
                      )}
                    </p>
                  )}
                  <details className="service-advanced">
                    <summary>{t('Opciones avanzadas')}</summary>
                    <div className="settings-grid">
                      {field('media.maxBytes')}
                      {tts !== 'default' &&
                        ['media.speech.ttsLanguage', 'media.speech.voice'].map(field)}
                      {stt !== 'default' &&
                        stt !== 'clipse-whisper' &&
                        field('media.speech.sttLanguage')}
                    </div>
                  </details>
                </>
              ) : group === 'search' ? (
                <>
                  <div className="settings-grid">{field('imageSearch.defaultProvider')}</div>
                  <div className="settings-grid">
                    {['braveApiKey', 'imageSearch.searchApiKey', 'imageSearch.serpApiKey'].map(
                      field,
                    )}
                  </div>
                  <p>
                    {t(
                      'SearchAPI y SerpApi ofrecen filtros de tamaño y fondo transparente. Comprueba el archivo original: los filtros no garantizan transparencia ni el modelo exacto.',
                    )}
                  </p>
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
  const t = useTranslations();
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
      setNotice(t('Ajustes guardados y aplicados.'));
    });
  }
  return (
    <section className="service-settings">
      <div className="service-settings-heading">
        <h2>{t('Ajustes')}</h2>
        <div className="action-group">
          {activeTab !== 'homeAssistant' && (
            <Button
              type="submit"
              form={formId}
              disabled={busy || !settings}
              size="icon"
              tooltip={t('Guardar ajustes')}
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
        <p>{t('Cargando ajustes…')}</p>
      )}
    </section>
  );
}
