'use client';
import { AssistantConnectionField } from './assistant-connection';
import { HATaskListPicker } from './ha-task-list-picker';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { useEffect, useState, type FormEvent } from 'react';
import { api, type Profile, type GoogleSettings, type SpeechSettings } from '../lib/api';
import { useAdminTask } from '../hooks/use-admin-task';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
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
import { Field, SelectField, CheckField } from './settings-fields';
import { AssistantAssignment } from './assistant-assignment';
import { ProfileCatalogs } from './profile-catalogs';
import { ProfileSpeech, defaultSpeech } from './profile-speech';
const capabilities = {
  web: 'Búsqueda web y lectura de páginas',
  transcription: 'Transcripción y archivos multimedia',
  calendar: 'Google Calendar',
  tasks: 'Tareas',
  documents: 'Google Docs / Drive',
  homeAssistant: 'Home Assistant',
};
const googleFields = {
  clientId: 'OAuth client ID',
  clientSecret: 'OAuth client secret',
  refreshToken: 'OAuth refresh token',
  calendarId: 'Calendar ID',
  taskListId: 'Task list ID',
  contextDocumentId: 'Documento de contexto',
  documentFolderId: 'Carpeta de documentos',
};
const googleServices = {
  calendar: 'Google Calendar',
  tasks: 'Tareas',
  docs: 'Google Docs',
  drive: 'Google Drive',
};
const haFields = {
  url: 'URL de Home Assistant',
  token: 'Long-lived access token',
  shoppingListEntity: 'Entidad de lista de compra',
  weatherEntity: 'Entidad de tiempo',
  locationEntity: 'Entidad de ubicación',
  geocodedLocationEntity: 'Entidad de dirección',
};
export function ProfileEditor({
  profile,
  timezone,
  onClose,
  onChanged,
}: {
  profile: Profile | null;
  timezone: string;
  onClose: () => void;
  onChanged: (message?: string) => Promise<void>;
}) {
  const { busy, notice, setNotice, run } = useAdminTask();
  const [current, setCurrent] = useState(profile),
    [version, setVersion] = useState(0),
    [speech, setSpeech] = useState<SpeechSettings>(profile?.speech || defaultSpeech);
  const [taskProvider, setTaskProvider] = useState(
    profile?.homeAssistant?.taskProvider || 'google',
  );
  const [provider, setProvider] = useState('profile');
  const path = (value: Pick<Profile, 'bot' | 'chatId'>) =>
    '/v1/admin/profiles/' + value.bot + '/' + encodeURIComponent(value.chatId);
  async function refresh() {
    if (!current) return;
    const result = await api<Profile>(path(current));
    setCurrent(result);
    setSpeech(result.speech || defaultSpeech);
    setTaskProvider(result.homeAssistant?.taskProvider || 'google');
    setVersion((value) => value + 1);
  }
  useEffect(() => {
    if (profile) void run(refresh);
  }, []);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const invalid = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input:invalid,select:invalid,textarea:invalid',
    );
    if (invalid) {
      const panel = invalid.closest<HTMLElement>('[data-settings-provider]');
      if (panel) setProvider(panel.dataset.settingsProvider!);
      for (let node = invalid.parentElement; node && node !== form; node = node.parentElement)
        if (node instanceof HTMLDetailsElement) node.open = true;
      requestAnimationFrame(() => invalid.reportValidity());
      return;
    }
    const data = new FormData(form);
    void run(async () => {
      const bot = current?.bot || (String(data.get('bot')) as Profile['bot']),
        chatId = current?.chatId || String(data.get('chatId') || '').trim();
      const value: Record<string, unknown> = {
        kind: current?.kind || data.get('kind'),
        label: String(data.get('label') || '').trim(),
        enabled: data.has('enabled'),
        voiceReplies: data.has('voiceReplies'),
        timezone: String(data.get('timezone') || '').trim(),
        memoryMode: data.get('memoryMode'),
        speech,
        capabilities: Object.keys(capabilities).filter((id) => data.has('cap-' + id)),
        confirmTaskProviderChange: data.has('confirmTaskProviderChange'),
        clearGoogle: data.has('clearGoogle'),
        clearHomeAssistant: data.has('clearHomeAssistant'),
      };
      const google: Record<string, unknown> = {};
      for (const key of Object.keys(googleFields))
        google[key] = String(data.get('google-' + key) || '').trim();
      const credentials: Record<string, Record<string, string>> = {};
      for (const service of Object.keys(googleServices)) {
        const credential: Record<string, string> = {};
        for (const field of ['clientId', 'clientSecret', 'refreshToken'])
          credential[field] = String(data.get('google-' + service + '-' + field) || '').trim();
        if (Object.values(credential).some(Boolean)) credentials[service] = credential;
      }
      if (Object.values(google).some(Boolean) || Object.keys(credentials).length)
        value.google = { ...google, credentials };
      const homeAssistant: Record<string, unknown> = {};
      for (const key of Object.keys(haFields))
        homeAssistant[key] = String(data.get('ha-' + key) || '').trim();
      homeAssistant.taskListEntity = String(
        data.get('ha-taskListEntity') || current?.homeAssistant?.taskListEntity || '',
      ).trim();
      homeAssistant.taskProvider =
        data.get('ha-taskProvider') || current?.homeAssistant?.taskProvider || 'google';
      homeAssistant.sensorEntities = String(data.get('ha-sensorEntities') || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (homeAssistant.url || homeAssistant.token) value.homeAssistant = homeAssistant;
      const result = await api<{ saved: boolean; warning?: string }>(
        path({ bot, chatId }),
        'PUT',
        value,
      );
      const saved = await api<Profile>(path({ bot, chatId }));
      setCurrent(saved);
      setSpeech(saved.speech || defaultSpeech);
      setTaskProvider(saved.homeAssistant?.taskProvider || 'google');
      setVersion((item) => item + 1);
      await onChanged();
      setNotice(result.warning || 'Perfil guardado. Los secretos vacíos se han conservado.');
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="profile-editor">
        <DialogHeader>
          <DialogTitle>
            {current ? 'Perfil · ' + current.label : 'Añadir usuario o grupo'}
          </DialogTitle>
          <DialogDescription>
            Configura los permisos y conexiones de este perfil. Su memoria e historial permanecen en
            la misma conversación.
          </DialogDescription>
        </DialogHeader>
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        <form key={version} onSubmit={save} noValidate>
          <fieldset disabled={busy}>
            <Tabs value={provider} onValueChange={setProvider} className="provider-settings">
              <TabsList aria-label="Proveedor de configuración" className="provider-tabs-list">
                <TabsTrigger value="profile">Perfil</TabsTrigger>
                <TabsTrigger value="google">Google</TabsTrigger>
                <TabsTrigger value="home-assistant">Home Assistant</TabsTrigger>
              </TabsList>
              <TabsContent value="profile" forceMount data-settings-provider="profile">
                <div className="settings-grid">
                  <AssistantConnectionField profile={current || undefined} disabled={busy} />
                  <SelectField
                    id="profile-kind"
                    name="kind"
                    label="Tipo de perfil"
                    defaultValue={current?.kind || 'user'}
                    disabled={!!current || busy}
                  >
                    <option value="user">Usuario privado</option>
                    <option value="group">Grupo</option>
                  </SelectField>
                </div>
                <Field
                  id="profile-chat-id"
                  name="chatId"
                  label="Chat ID"
                  inputMode="numeric"
                  defaultValue={current?.chatId || ''}
                  readOnly={!!current}
                  required
                  pattern="-?[0-9]{1,16}"
                  placeholder="123456789 o -1001234567890"
                />
                <Field
                  id="profile-label"
                  name="label"
                  label="Nombre"
                  defaultValue={current?.label || ''}
                  maxLength={100}
                  required
                />
                <CheckField
                  id="profile-enabled"
                  name="enabled"
                  label="Permitir respuestas en este chat"
                  defaultChecked={!!current?.enabled}
                />
                <CheckField
                  id="profile-voice-replies"
                  name="voiceReplies"
                  label="Respuestas de voz"
                  defaultChecked={current?.voiceReplies !== false}
                />
                <div className="settings-grid">
                  <Field
                    id="profile-timezone"
                    name="timezone"
                    label="Zona horaria"
                    defaultValue={current?.timezone || timezone}
                    required
                    maxLength={100}
                    placeholder="Europe/Madrid"
                  />
                  <SelectField
                    id="profile-memory-mode"
                    name="memoryMode"
                    label="Memoria a largo plazo"
                    defaultValue={current?.memoryMode || 'advanced'}
                  >
                    <option value="advanced">Avanzada · búsqueda semántica</option>
                    <option value="simple">Simple · búsqueda por palabras</option>
                    <option value="none">Sin memoria a largo plazo</option>
                  </SelectField>
                </div>
                <small>
                  El reinicio y la consolidación siguen esta zona horaria. Desactivar la memoria
                  conserva los recuerdos existentes y deja de consultarlos.
                </small>
                <h3 className="settings-heading">Herramientas permitidas</h3>
                <div className="settings-grid">
                  {Object.entries(capabilities)
                    .filter(([id]) => id !== 'homeAssistant' || current?.hasHomeAssistant)
                    .map(([id, label]) => (
                      <CheckField
                        key={id}
                        id={'profile-cap-' + id}
                        name={'cap-' + id}
                        label={label}
                        defaultChecked={(
                          current?.capabilities || ['web', 'transcription']
                        ).includes(id)}
                      />
                    ))}
                </div>
              </TabsContent>
              <TabsContent value="google" forceMount data-settings-provider="google">
                <section>
                  <h3 className="settings-heading">Google · calendario, tareas y documentos</h3>
                  <p>
                    {current?.hasGoogle
                      ? 'Hay credenciales guardadas.'
                      : current?.owner
                        ? 'Se usa la conexión original del propietario mientras no se sustituya.'
                        : 'Configura las credenciales propias del perfil.'}{' '}
                    Un secreto vacío conserva su valor guardado.
                  </p>
                  <div className="settings-grid">
                    {Object.entries(googleFields).map(([key, label]) => (
                      <Field
                        key={key}
                        id={'profile-google-' + key}
                        name={'google-' + key}
                        label={label}
                        type={
                          key === 'clientSecret' || key === 'refreshToken' ? 'password' : 'text'
                        }
                        autoComplete="off"
                        defaultValue={
                          key === 'clientSecret' || key === 'refreshToken'
                            ? ''
                            : String(current?.google?.[key as keyof GoogleSettings] || '')
                        }
                      />
                    ))}
                  </div>
                  <div className="settings-section">
                    <h3>Credenciales por servicio</h3>
                    <p>
                      Cada servicio puede usar su propia conexión OAuth. Sin una conexión específica
                      se usa la conexión Google del perfil.
                    </p>
                    <Tabs defaultValue="calendar" className="provider-settings">
                      <TabsList aria-label="Servicio de Google" className="provider-tabs-list">
                        {Object.entries(googleServices).map(([id, label]) => (
                          <TabsTrigger value={id} key={id}>
                            {label.replace('Google ', '')}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                      {Object.entries(googleServices).map(([service, label]) => (
                        <TabsContent value={service} forceMount key={service}>
                          <h4>{label}</h4>
                          <small>
                            {current?.google?.credentials?.[service as keyof typeof googleServices]
                              ?.configured
                              ? 'Conexión propia guardada.'
                              : 'Usa la conexión Google del perfil.'}
                          </small>
                          {['clientId', 'clientSecret', 'refreshToken'].map((key) => (
                            <Field
                              key={key}
                              id={'profile-google-' + service + '-' + key}
                              name={'google-' + service + '-' + key}
                              label={
                                key === 'clientId'
                                  ? 'OAuth client ID'
                                  : key === 'clientSecret'
                                    ? 'OAuth client secret'
                                    : 'OAuth refresh token'
                              }
                              type={key === 'clientId' ? 'text' : 'password'}
                              autoComplete="off"
                              defaultValue={
                                key === 'clientId'
                                  ? current?.google?.credentials?.[
                                      service as keyof typeof googleServices
                                    ]?.clientId || ''
                                  : ''
                              }
                            />
                          ))}
                        </TabsContent>
                      ))}
                    </Tabs>
                  </div>
                  <CheckField
                    id="profile-clear-google"
                    name="clearGoogle"
                    label="Borrar la conexión Google guardada"
                  />
                </section>
              </TabsContent>
              <TabsContent
                value="home-assistant"
                forceMount
                data-settings-provider="home-assistant"
              >
                <section>
                  <h3 className="settings-heading">Home Assistant · conexión y entidades</h3>
                  <p>
                    {current?.hasHomeAssistant
                      ? 'Hay un token guardado.'
                      : current?.owner
                        ? 'Se usa la conexión original del propietario mientras no se sustituya.'
                        : 'Sin token guardado.'}{' '}
                    Deja el token vacío para conservarlo.
                  </p>
                  <div className="settings-grid">
                    {Object.entries(haFields)
                      .filter(
                        ([key]) => current?.hasHomeAssistant || ['url', 'token'].includes(key),
                      )
                      .map(([key, label]) => (
                        <Field
                          key={key}
                          id={'profile-ha-' + key}
                          name={'ha-' + key}
                          label={label}
                          type={key === 'token' ? 'password' : key === 'url' ? 'url' : 'text'}
                          autoComplete="off"
                          defaultValue={
                            key === 'token'
                              ? ''
                              : String(
                                  current?.homeAssistant?.[
                                    key as keyof NonNullable<Profile['homeAssistant']>
                                  ] || '',
                                )
                          }
                        />
                      ))}
                  </div>
                  {current?.hasHomeAssistant && (
                    <>
                      <HATaskListPicker profile={current} />
                      <p>
                        Home Assistant está conectado. Puedes usar una lista to-do para las tareas
                        de este perfil.
                      </p>
                    </>
                  )}
                  <SelectField
                    id="profile-task-provider"
                    name="ha-taskProvider"
                    label="Proveedor de tareas"
                    value={taskProvider}
                    onChange={(event) => setTaskProvider(event.target.value as typeof taskProvider)}
                  >
                    <option value="google">Google Tasks directo</option>
                    {(current?.hasHomeAssistant || taskProvider === 'home_assistant') && (
                      <option value="home_assistant">Home Assistant · to-do</option>
                    )}
                  </SelectField>
                  {taskProvider !== (current?.homeAssistant?.taskProvider || 'google') && (
                    <CheckField
                      id="confirm-task-provider"
                      name="confirmTaskProviderChange"
                      required
                      label="Confirmo el cambio de proveedor. No se migran tareas; se conservan las credenciales anteriores."
                    />
                  )}
                  {current?.hasHomeAssistant && (
                    <Field
                      id="profile-ha-sensors"
                      name="ha-sensorEntities"
                      label="Sensores permitidos (separados por coma)"
                      defaultValue={(current?.homeAssistant?.sensorEntities || []).join(', ')}
                    />
                  )}
                  <CheckField
                    id="profile-clear-ha"
                    name="clearHomeAssistant"
                    label="Borrar la conexión Home Assistant guardada"
                  />
                </section>
                {current?.hasHomeAssistant && (
                  <ProfileSpeech profile={current} value={speech} onChange={setSpeech} />
                )}
                {current?.hasHomeAssistant && <ProfileCatalogs profile={current} />}
              </TabsContent>
            </Tabs>
            <p className="settings-help">
              Los secretos nunca se muestran. Los cambios se aplican a las próximas solicitudes.
            </p>
            <div className="form-actions">
              <Button disabled={busy}>Guardar perfil</Button>
              {current && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(refresh)}
                >
                  Recargar perfil
                </Button>
              )}
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Cerrar
              </Button>
            </div>
          </fieldset>
        </form>
        {current && (
          <div className="settings-section">
            <h3>Asistente asignado</h3>
            <AssistantAssignment
              profile={current}
              onAssigned={async () => {
                await refresh();
                await onChanged();
              }}
            />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="ghost" className="danger" disabled={busy}>
                  Eliminar perfil
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>¿Eliminar {current.label}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Se quitarán el acceso y las credenciales de {current.bot} · {current.chatId}. Su
                    historial se conserva. El menú de Telegram se actualizará si el perfil estaba
                    activo.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{ deleted: boolean; warning?: string }>(
                          path(current),
                          'DELETE',
                        );
                        await onChanged(result.warning || 'Perfil eliminado.');
                        onClose();
                      })
                    }
                  >
                    Eliminar perfil
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
