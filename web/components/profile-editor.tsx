'use client';
import { ProfileNotifications } from './profile-notifications';
import { HAConnectionPicker, type HAConnectionChoice } from './ha-connection-picker';
import { SecretEditor } from './secret-editor';
import { Badge } from './ui/badge';
import { HAEntityPicker } from './ha-entity-picker';
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
import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  const confirmedNotifications = useRef(false);
  const confirmedLocations = useRef(false);
  const [confirmLocations, setConfirmLocations] = useState<string[]>();
  const [confirmNotifications, setConfirmNotifications] = useState(false);
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
  const [clearHAConnection, setClearHAConnection] = useState(false);
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
    setClearHAConnection(false);
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
    const changedMorning =
      current &&
      data.has('morningMode') &&
      (data.get('morningMode') !== current.notifications?.morning.mode ||
        (data.get('morningMode') === 'time' &&
          data.get('morningTime') !== current.notifications?.morning.time) ||
        (data.get('morningMode') === 'entity' &&
          (data.get('morningEntity') !== current.notifications?.morning.entity ||
            data.get('morningState') !== current.notifications?.morning.state)));
    if (
      (changedMorning ||
        (data.has('eventReminders') && !current?.notifications?.eventReminders) ||
        (data.has('dailyReset') &&
          (!current?.notifications?.reset?.enabled ||
            data.get('dailyResetTime') !== current.notifications.reset.time))) &&
      !confirmedNotifications.current
    ) {
      setConfirmNotifications(true);
      return;
    }
    confirmedNotifications.current = false;
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
        ...(current && (data.has('morningMode') || data.has('dailyResetTime'))
          ? {
              notifications: {
                eventReminders: data.has('morningMode')
                  ? data.has('eventReminders')
                  : current.notifications?.eventReminders || false,
                reset: {
                  enabled: data.has('dailyReset'),
                  time: String(
                    data.get('dailyResetTime') || current.notifications?.reset?.time || '04:00',
                  ),
                },
                morning: {
                  mode: String(
                    data.get('morningMode') || current.notifications?.morning.mode || 'off',
                  ),
                  time: String(
                    data.get('morningTime') || current.notifications?.morning.time || '08:30',
                  ),
                  entity: String(
                    data.get('morningEntity') ?? current.notifications?.morning.entity ?? '',
                  ),
                  state: String(
                    data.get('morningState') ?? current.notifications?.morning.state ?? 'off',
                  ),
                },
              },
            }
          : {}),
        capabilities: Object.keys(capabilities).filter(
          (id) =>
            data.has('cap-' + id) ||
            (id === 'homeAssistant' &&
              (data.get('saveHAConnection') === 'true' ||
                (!current?.hasHomeAssistant && haConnections.length > 0))),
        ),

        clearHomeAssistant: clearHAConnection,
        homeAssistantConnectionIds: clearHAConnection ? [] : haConnections.map((item) => item.id),
        ...(!clearHAConnection && activeHAConnection
          ? { activeHomeAssistantConnectionId: activeHAConnection }
          : {}),
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
      if (
        current?.hasHomeAssistant ||
        homeAssistant.url ||
        homeAssistant.token ||
        haConnections.length > 0
      )
        value.homeAssistant = homeAssistant;
      value.confirmLocationExposure = confirmedLocations.current;
      confirmedLocations.current = false;
      const result = await api<{
        saved: boolean;
        warning?: string;
        confirmationRequired?: string[];
      }>(path({ bot, chatId }), 'PUT', value);
      if (result.confirmationRequired?.length) {
        confirmedNotifications.current = true;
        setConfirmLocations(result.confirmationRequired);
        return;
      }
      const saved = await api<Profile>(path({ bot, chatId }));
      setCurrent(saved);
      setClearHAConnection(false);

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
    <>
      <AlertDialog
        open={!!confirmLocations}
        onOpenChange={(open) => {
          if (!open) setConfirmLocations(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Exponer esta ubicación a Assist?</AlertDialogTitle>
            <AlertDialogDescription>
              Para usar {confirmLocations?.join(', ')}, Zero la añadirá a las entidades expuestas a
              Assist. Estará disponible para Assist y Zero en toda esta instancia de Home Assistant.
              Quitar la asignación del perfil no la ocultará de Assist.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmedLocations.current = true;
                setConfirmLocations(undefined);
                (
                  document.getElementById('profile-settings-form') as HTMLFormElement
                )?.requestSubmit();
              }}
            >
              Exponer y guardar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmNotifications} onOpenChange={setConfirmNotifications}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Aplicar las notificaciones de este perfil?</AlertDialogTitle>
            <AlertDialogDescription>
              El resumen, los recordatorios y la nueva sesión diaria seguirán estas preferencias. El
              reinicio diario limpia el contexto de conversación. Si has elegido una entidad, Zero
              escuchará sus cambios en Home Assistant.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmedNotifications.current = true;
                (
                  document.getElementById('profile-settings-form') as HTMLFormElement
                )?.requestSubmit();
              }}
            >
              Aplicar y guardar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
                                  if (value !== true && provider === 'tasks')
                                    setProvider('profile');
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
                      onChange={(event) =>
                        setTaskProvider(event.target.value as typeof taskProvider)
                      }
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
                          setClearHAConnection(false);
                          setHAConnections(selected);
                          setActiveHAConnection(active);
                        }}
                      />
                      <a className="underline" href="?page=services&settingsTab=homeAssistant">
                        Gestionar conexiones de Home Assistant
                      </a>
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
                            configured={!clearHAConnection && !!current?.homeAssistant?.tokenHint}
                            hint={current?.homeAssistant?.tokenHint}
                            preview={
                              clearHAConnection ? 'La conexión se eliminará al guardar' : undefined
                            }
                            onChange={(value) => {
                              if (value) setClearHAConnection(false);
                            }}
                            deleteAction={
                              !!current?.homeAssistant?.tokenHint && !clearHAConnection ? (
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="destructive"
                                      size="icon-sm"
                                      tooltip="Eliminar conexión del perfil"
                                      disabled={busy}
                                    >
                                      <Trash2 />
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>
                                        ¿Eliminar la conexión del perfil?
                                      </AlertDialogTitle>
                                      <AlertDialogDescription>
                                        La URL y el token guardados en este perfil se eliminarán al
                                        guardar. Para eliminar el servidor de todos los perfiles,
                                        usa Gestionar conexiones.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                      <AlertDialogAction
                                        variant="destructive"
                                        onClick={() => setClearHAConnection(true)}
                                      >
                                        Eliminar al guardar
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              ) : undefined
                            }
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
                            assignment={
                              key === 'locationEntity' || key === 'geocodedLocationEntity'
                            }
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
                      <p className="settings-help">
                        Las entidades disponibles y sus permisos se gestionan en Home Assistant →
                        Ajustes → Asistentes de voz → Exponer, seleccionando Assist. Las entidades
                        asignadas aquí deben estar expuestas a Assist; si falta exposición, Zero
                        pedirá confirmación para añadirlas a Assist.
                      </p>
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
                    <ProfileNotifications key={version} profile={current} />
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
                        Se quitarán el acceso y las credenciales de {current.bot} · {current.chatId}
                        . Su historial se conserva. El menú de Telegram se actualizará si el perfil
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
    </>
  );
}
