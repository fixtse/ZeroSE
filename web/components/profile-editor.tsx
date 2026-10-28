'use client';
import { HAConnectionPicker, type HAConnectionChoice } from './ha-connection-picker';
import { SecretEditor } from './secret-editor';
import { Badge } from './ui/badge';
import { HAEntityPicker } from './ha-entity-picker';
import { HAEntityMultiPicker } from './ha-entity-multi-picker';
import { TimezoneOptions } from './timezone-options';
import { notifyWarning } from '../lib/notifications';
import {
  Brain,
  BellRing,
  ListTodo,
  AudioLines,
  NotebookText,
  RefreshCw,
  Save,
  Trash2,
  UserRound,
  Users,
  Workflow,
} from 'lucide-react';
import { HomeAssistantIcon } from './home-assistant-icon';
import { useUrlState } from '../hooks/use-url-state';
import { GoogleConnectionSettings } from './google-connection';
import { GoogleDestinationPicker } from './google-destination-picker';
import { ProfileModels } from './ai-settings';
import { ProfileContext } from './profile-context';
import { ProfileMemory } from './profile-memory';
import { GroupMembers } from './group-members';
import { AssistantConnectionField } from './assistant-connection';
import { HATaskListPicker } from './ha-task-list-picker';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { useEffect, useState, type FormEvent } from 'react';
import { api, type Profile, type SpeechSettings } from '../lib/api';
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
const googleServices = {
  calendar: 'Google Calendar',
  tasks: 'Tareas',
  docs: 'Docs / Drive',
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
  onCreated,
}: {
  profile: Profile | null;
  timezone: string;
  onClose: () => void;
  onChanged: (message?: string) => Promise<void>;
  onCreated: (profile: Profile) => void;
}) {
  const { busy, setNotice, run } = useAdminTask();
  const [current, setCurrent] = useState(profile),
    [version, setVersion] = useState(0),
    [speech, setSpeech] = useState<SpeechSettings>(profile?.speech || defaultSpeech);
  const [taskProvider, setTaskProvider] = useState(
    profile?.homeAssistant?.taskProvider || 'google',
  );
  const [tasksEnabled, setTasksEnabled] = useState(!!profile?.capabilities.includes('tasks'));
  const [kind, setKind] = useState(profile?.kind || 'user');
  const [haConnections, setHAConnections] = useState<HAConnectionChoice[]>(
    profile?.homeAssistant?.connections || [],
  );
  const [activeHAConnection, setActiveHAConnection] = useState(
    profile?.homeAssistant?.activeConnectionId || '',
  );
  const [provider, setProvider] = useUrlState('profileTab', 'profile');
  const membersAvailable = current?.kind === 'group' && current.hasHomeAssistant;
  useEffect(() => {
    if (provider === 'members' && !membersAvailable) setProvider('profile');
  }, [provider, membersAvailable, setProvider]);
  const enabledGoogleServices = Object.entries(googleServices).filter(([service]) =>
    service === 'tasks'
      ? current?.capabilities.includes('tasks') &&
        current.homeAssistant?.taskProvider !== 'home_assistant'
      : current?.capabilities.includes(service === 'docs' ? 'documents' : 'calendar'),
  );
  const path = (value: Pick<Profile, 'bot' | 'chatId'>) =>
    '/v1/admin/profiles/' + value.bot + '/' + encodeURIComponent(value.chatId);
  async function refresh() {
    if (!current) return;
    const result = await api<Profile>(path(current));
    setCurrent(result);
    setTasksEnabled(result.capabilities.includes('tasks'));
    setSpeech(result.speech || defaultSpeech);
    setTaskProvider(result.homeAssistant?.taskProvider || 'google');
    setHAConnections(result.homeAssistant?.connections || []);
    setActiveHAConnection(result.homeAssistant?.activeConnectionId || '');
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
    const data = new FormData(
      form,
      (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null,
    );
    void run(async () => {
      const bot = current?.bot || (String(data.get('bot')) as Profile['bot']),
        chatId = current?.chatId || String(data.get('chatId') || '').trim();
      const value: Record<string, unknown> = {
        kind: current?.kind || data.get('kind'),
        label: String(data.get('label') || '').trim(),
        enabled: data.has('enabled'),
        voiceReplies: data.has('voiceReplies'),
        ...(kind === 'group' ? { respondToReplies: data.has('respondToReplies') } : {}),
        timezone: String(data.get('timezone') || '').trim(),
        memoryMode: data.get('memoryMode'),
        speech,
        capabilities: Object.keys(capabilities).filter(
          (id) =>
            data.has('cap-' + id) ||
            (id === 'homeAssistant' &&
              (data.get('saveHAConnection') === 'true' ||
                (!current?.hasHomeAssistant && haConnections.length > 0))),
        ),

        homeAssistantConnectionIds: haConnections.map((item) => item.id),
        ...(activeHAConnection ? { activeHomeAssistantConnectionId: activeHAConnection } : {}),
      };
      if (data.has('modelsLoaded')) {
        value.defaultModel = String(data.get('defaultModel') || '');
        value.alternateModels = data.getAll('alternateModels').map(String);
      }
      const homeAssistant: Record<string, unknown> = {};
      for (const key of Object.keys(haFields))
        if (data.has('ha-' + key)) homeAssistant[key] = String(data.get('ha-' + key) || '').trim();
        else if (key !== 'token' && key !== 'url')
          homeAssistant[key] =
            current?.homeAssistant?.[key as keyof NonNullable<Profile['homeAssistant']>] || '';
      if (current?.source !== 'home_assistant' && !data.has('ha-url'))
        homeAssistant.url = current?.homeAssistant?.url || '';
      homeAssistant.taskListEntity = String(
        data.get('ha-taskListEntity') || current?.homeAssistant?.taskListEntity || '',
      ).trim();
      homeAssistant.taskProvider =
        data.get('ha-taskProvider') || current?.homeAssistant?.taskProvider || 'google';
      homeAssistant.sensorEntities = String(
        data.get('ha-sensorEntities') ?? current?.homeAssistant?.sensorEntities?.join(',') ?? '',
      )
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (
        current?.hasHomeAssistant ||
        homeAssistant.url ||
        homeAssistant.token ||
        haConnections.length > 0
      )
        value.homeAssistant = homeAssistant;
      const result = await api<{ saved: boolean; warning?: string }>(
        path({ bot, chatId }),
        'PUT',
        value,
      );
      const saved = await api<Profile>(path({ bot, chatId }));
      setCurrent(saved);

      setTasksEnabled(saved.capabilities.includes('tasks'));
      setSpeech(saved.speech || defaultSpeech);
      setTaskProvider(saved.homeAssistant?.taskProvider || 'google');
      setHAConnections(saved.homeAssistant?.connections || []);
      setActiveHAConnection(saved.homeAssistant?.activeConnectionId || '');
      setVersion((item) => item + 1);
      await onChanged();
      if (result.warning) notifyWarning(result.warning);
      else setNotice('Perfil guardado.');
      if (!current) onCreated(saved);
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
          <div className="profile-title-row">
            <DialogTitle>
              {current ? 'Perfil · ' + current.label : 'Añadir usuario o grupo'}
              {current && (
                <Badge variant="secondary" className="ml-2 align-middle">
                  {current.kind === 'group' ? 'Grupo' : 'Usuario privado'}
                </Badge>
              )}
            </DialogTitle>
            {current && (
              <AssistantAssignment
                profile={current}
                onAssigned={async () => {
                  await refresh();
                  await onChanged();
                }}
              />
            )}
          </div>
          <DialogDescription>Permisos y conexiones de este perfil.</DialogDescription>
        </DialogHeader>
        <form id="profile-settings-form" key={version} onSubmit={save} noValidate>
          <fieldset disabled={busy}>
            <Tabs value={provider} onValueChange={setProvider} className="provider-settings">
              <TabsList aria-label="Proveedor de configuración" className="provider-tabs-list">
                <TabsTrigger value="profile">
                  <UserRound aria-hidden="true" />
                  Perfil
                </TabsTrigger>
                {current && (
                  <TabsTrigger value="context">
                    <NotebookText aria-hidden="true" />
                    Contexto
                  </TabsTrigger>
                )}
                {current && (
                  <TabsTrigger value="memory">
                    <Brain aria-hidden="true" />
                    Memoria
                  </TabsTrigger>
                )}
                <TabsTrigger value="google">
                  <Workflow aria-hidden="true" />
                  Google
                </TabsTrigger>
                {tasksEnabled && (
                  <TabsTrigger value="tasks">
                    <ListTodo aria-hidden="true" />
                    Tareas
                  </TabsTrigger>
                )}
                <TabsTrigger value="home-assistant">
                  <HomeAssistantIcon aria-hidden="true" />
                  Home Assistant
                </TabsTrigger>
                {current && (
                  <TabsTrigger value="notifications">
                    <BellRing aria-hidden="true" />
                    Alertas y recordatorios
                  </TabsTrigger>
                )}
                <TabsTrigger value="speech">
                  <AudioLines aria-hidden="true" />
                  Voz
                </TabsTrigger>
                {membersAvailable && (
                  <TabsTrigger value="members">
                    <Users aria-hidden="true" />
                    Integrantes
                  </TabsTrigger>
                )}
              </TabsList>
              {membersAvailable && (
                <TabsContent value="members" forceMount data-settings-provider="members">
                  <GroupMembers profile={current} active={provider === 'members'} />
                </TabsContent>
              )}
              <TabsContent value="profile" forceMount data-settings-provider="profile">
                {!current && (
                  <div className="settings-grid">
                    <AssistantConnectionField disabled={busy} />
                    <SelectField
                      id="profile-kind"
                      name="kind"
                      label="Tipo de perfil"
                      defaultValue="user"
                      onChange={(event) => {
                        setKind(event.target.value as Profile['kind']);
                      }}
                      disabled={busy}
                    >
                      <option value="user">Usuario privado</option>
                      <option value="group">Grupo</option>
                    </SelectField>
                  </div>
                )}
                {current ? (
                  <p className="settings-help">
                    {current.source === 'home_assistant' ? 'Home Assistant user ID' : 'Chat ID'}:{' '}
                    {current.chatId}
                  </p>
                ) : (
                  <Field
                    id="profile-chat-id"
                    name="chatId"
                    label="Chat ID"
                    inputMode="numeric"
                    required
                    pattern="-?[0-9]{1,16}"
                    placeholder="123456789 o -1001234567890"
                  />
                )}
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
                {kind === 'group' && (
                  <CheckField
                    id="profile-respond-to-replies"
                    name="respondToReplies"
                    label="Responder cuando contesten a un mensaje del asistente"
                    defaultChecked={current?.respondToReplies !== false}
                  />
                )}
                <div className="settings-grid">
                  <Field
                    id="profile-timezone"
                    name="timezone"
                    label="Zona horaria"
                    defaultValue={current?.timezone || timezone}
                    required
                    maxLength={100}
                    placeholder="Europe/Madrid"
                    list="timezone-options"
                    autoComplete="off"
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
                <TimezoneOptions id="timezone-options" />
                <ProfileModels key={version} profile={current} />
                <h3 className="settings-heading">Herramientas permitidas</h3>
                <div className="settings-grid">
                  {Object.entries(capabilities)
                    .filter(
                      ([id]) =>
                        id !== 'homeAssistant' ||
                        current?.hasHomeAssistant ||
                        haConnections.length > 0,
                    )
                    .map(([id, label]) => (
                      <CheckField
                        key={id}
                        id={'profile-cap-' + id}
                        name={'cap-' + id}
                        label={label}
                        {...(id === 'tasks'
                          ? {
                              checked: tasksEnabled,
                              onCheckedChange: (value) => {
                                setTasksEnabled(value === true);
                                if (value !== true && provider === 'tasks') setProvider('profile');
                              },
                            }
                          : {})}
                        defaultChecked={(
                          current?.capabilities || ['web', 'transcription']
                        ).includes(id)}
                      />
                    ))}
                </div>
              </TabsContent>
              {current && (
                <TabsContent value="context" forceMount data-settings-provider="context">
                  <ProfileContext profile={current} />
                </TabsContent>
              )}
              {current && (
                <TabsContent value="memory" forceMount data-settings-provider="memory">
                  <ProfileMemory
                    key={current.bot + ':' + current.chatId}
                    profile={current}
                    active={provider === 'memory'}
                  />
                </TabsContent>
              )}
              <TabsContent value="google" forceMount data-settings-provider="google">
                <section className="google-settings">
                  <GoogleConnectionSettings profile={current} />
                  {enabledGoogleServices.length > 0 && (
                    <div className="settings-section">
                      <h3>Destinos de Google</h3>
                      <div className="grid gap-4">
                        {enabledGoogleServices.map(([service]) => (
                          <GoogleDestinationPicker
                            key={service}
                            profile={current}
                            service={service as 'calendar' | 'tasks' | 'docs'}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              </TabsContent>
              {tasksEnabled && (
                <TabsContent value="tasks" forceMount data-settings-provider="tasks">
                  <h3 className="settings-heading">Proveedor de tareas</h3>
                  <p>Elige Google Tasks o una lista to-do de Home Assistant para este usuario.</p>
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
                  {taskProvider === 'home_assistant' && current?.hasHomeAssistant && (
                    <HATaskListPicker profile={current} />
                  )}
                </TabsContent>
              )}
              <TabsContent
                value="home-assistant"
                forceMount
                data-settings-provider="home-assistant"
              >
                {
                  <section className="ha-connection-settings">
                    <h3>Conexión de Home Assistant</h3>
                    <HAConnectionPicker
                      selected={haConnections}
                      active={activeHAConnection}
                      onChange={(selected, active) => {
                        setHAConnections(selected);
                        setActiveHAConnection(active);
                      }}
                    />
                    {haConnections.length === 0 && (
                      <div className="ha-manual-connection">
                        <Field
                          id="profile-ha-url"
                          name="ha-url"
                          label="URL de Home Assistant"
                          type="url"
                          defaultValue={current?.homeAssistant?.url || ''}
                        />
                        <SecretEditor
                          id="profile-ha-token"
                          name="ha-token"
                          label="Token de acceso"
                          configured={!!current?.homeAssistant?.tokenHint}
                          hint={current?.homeAssistant?.tokenHint}
                          disabled={busy}
                          actions={
                            <Button
                              type="submit"
                              name="saveHAConnection"
                              value="true"
                              disabled={busy}
                              size="icon"
                              tooltip="Guardar conexión de Home Assistant"
                            >
                              <Save />
                            </Button>
                          }
                        />
                      </div>
                    )}
                  </section>
                }
                {current?.hasHomeAssistant ? (
                  <>
                    <div className="settings-grid">
                      {(kind === 'group'
                        ? ['shoppingListEntity', 'weatherEntity']
                        : [
                            'shoppingListEntity',
                            'weatherEntity',
                            'locationEntity',
                            'geocodedLocationEntity',
                          ]
                      ).map((key) => (
                        <HAEntityPicker
                          key={key}
                          profile={current}
                          id={'profile-ha-' + key}
                          name={'ha-' + key}
                          label={haFields[key as keyof typeof haFields]}
                          domains={
                            key === 'shoppingListEntity'
                              ? 'todo'
                              : key === 'weatherEntity'
                                ? 'weather'
                                : key === 'locationEntity'
                                  ? 'person,device_tracker'
                                  : 'sensor'
                          }
                          defaultValue={String(
                            current.homeAssistant?.[
                              key as keyof NonNullable<Profile['homeAssistant']>
                            ] || '',
                          )}
                        />
                      ))}
                    </div>
                    <p className="settings-help">
                      La entidad de tiempo se usa para consultar el pronóstico y evaluar alertas
                      meteorológicas.
                    </p>
                    <HAEntityMultiPicker
                      profile={current}
                      id="profile-ha-sensors"
                      name="ha-sensorEntities"
                      label="Sensores y ubicaciones permitidos"
                      domains="sensor,binary_sensor,person,zone"
                      defaultValues={current.homeAssistant?.sensorEntities || []}
                    />
                  </>
                ) : (
                  <p className="settings-help">
                    {kind === 'group'
                      ? 'Guarda primero la conexión de Home Assistant.'
                      : 'Las entidades estarán disponibles cuando este usuario tenga una conexión de Home Assistant.'}
                  </p>
                )}
              </TabsContent>
              {current && (
                <TabsContent
                  value="notifications"
                  forceMount
                  data-settings-provider="notifications"
                >
                  <ProfileCatalogs profile={current} active={provider === 'notifications'} />
                </TabsContent>
              )}
              <TabsContent value="speech" forceMount data-settings-provider="speech">
                <ProfileSpeech
                  profile={current}
                  active={provider === 'speech'}
                  value={speech}
                  onChange={setSpeech}
                />
              </TabsContent>
            </Tabs>
          </fieldset>
        </form>
        <div className="editor-action-bar">
          {current && (
            <div className="profile-danger-actions">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="danger"
                    disabled={busy}
                    size="icon"
                    tooltip="Eliminar perfil"
                  >
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>¿Eliminar {current.label}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Se quitarán el acceso y las credenciales de {current.bot} · {current.chatId}.
                      Su historial se conserva. El menú de Telegram se actualizará si el perfil
                      estaba activo.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
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
          <div
            className="action-group profile-save-actions"
            role="group"
            aria-label="Acciones del perfil"
          >
            <Button
              form="profile-settings-form"
              disabled={busy}
              size="icon"
              tooltip="Guardar perfil"
            >
              <Save />
            </Button>
            {current && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void run(refresh)}
                size="icon"
                tooltip="Recargar perfil"
              >
                <RefreshCw />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
