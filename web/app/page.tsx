'use client';
import { PairingProfilePicker, type PairingTarget } from '../components/pairing-profile-picker';
import { notify as setNotice, notifyError, notifyWarning } from '../lib/notifications';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cpu,
  KeyRound,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Unlink,
  Users,
  X,
} from 'lucide-react';
import { adminPath } from '../lib/admin-path';
import { useUrlState } from '../hooks/use-url-state';
import { useQueryClient } from '@tanstack/react-query';
import { AISettingsEditor } from '../components/ai-settings';
import { authClient, authResult } from '../lib/auth-client';
import { HomeAssistantIndicator } from '../components/home-assistant-indicator';
import { TelegramAvatar } from '../components/telegram-avatar';
import { AssistantConnectionName } from '../components/assistant-connection';
import { useEffect, useState, useRef, type FormEvent } from 'react';
import { api, SessionExpired, type Profile, type Settings, type Pairing } from '../lib/api';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Checkbox } from '../components/ui/checkbox';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { AssistantCatalog } from '../components/assistant-catalog';
import { AssistantAssignment } from '../components/assistant-assignment';
import { ProfileEditor } from '../components/profile-editor';
import { ServiceSettings } from '../components/service-settings';
import { AccountSettings } from '../components/account-settings';
import { CheckField } from '../components/settings-fields';
const base = '/v1/admin/setup';
const navigation = [
  { id: 'people', label: 'Usuarios', Icon: Users },
  { id: 'settings', label: 'Asistentes', Icon: Sparkles },
  { id: 'services', label: 'Ajustes', Icon: SettingsIcon },
  { id: 'ai', label: 'Proveedores IA', Icon: Cpu },
  { id: 'security', label: 'Seguridad', Icon: ShieldCheck },
];
export default function Home() {
  const queryClient = useQueryClient();
  const [authenticated, setAuthenticated] = useState(false),
    [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useUrlState('page', 'people');
  const [profiles, setProfiles] = useState<Profile[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [search, setSearch] = useState('');
  const [settings, setSettings] = useState<Settings>(),
    [connection, setConnection] = useState<{
      url: string;
      callbackUrl: string;
      homeAssistantConnected: boolean;
    }>();
  const [pairing, setPairing] = useState<Pairing>(),
    [pairingId, setPairingId] = useState(''),
    [pairingTarget, setPairingTarget] = useState<PairingTarget>();
  const [secondFactor, setSecondFactor] = useState(false);
  const [backupCode, setBackupCode] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [recoveryUsername, setRecoveryUsername] = useState('');
  const [setupRequired, setSetupRequired] = useState(false);
  const [ingress, setIngress] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null | undefined>();
  const [profileRoute, setProfileRoute] = useUrlState('profile', '');
  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    if (!profileRoute) setEditingProfile(undefined);
    else if (profileRoute === 'new') setEditingProfile(null);
    else
      void api<Profile>('/v1/admin/profiles/' + profileRoute)
        .then((profile) => {
          if (active) setEditingProfile(profile);
        })
        .catch((error) => {
          if (active) notifyError(error);
        });
    return () => {
      active = false;
    };
  }, [profileRoute, authenticated]);
  const [defaultTimezone, setDefaultTimezone] = useState('Europe/Madrid');
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  function lock() {
    queryClient.clear();
    setAuthenticated(false);
    setSecondFactor(false);
    setBackupCode(false);
    setProfiles([]);
    setSettings(undefined);
    setPairing(undefined);
    setEditingProfile(undefined);
  }
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (error instanceof SessionExpired) lock();
      notifyError(error instanceof Error ? error.message : 'No se pudo completar la operación.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function loadProfiles(query = search, start = offset, onlyPending = pending) {
    const result = await api<{
      items: Profile[];
      total: number;
      timezone: string;
      discoveryWarning?: string;
    }>(
      '/v1/admin/profiles?limit=20&offset=' +
        start +
        '&pending=' +
        onlyPending +
        '&search=' +
        encodeURIComponent(query),
    );
    setProfiles(result.items);
    if (result.discoveryWarning) notifyWarning(result.discoveryWarning);
    setDefaultTimezone(result.timezone);
    setTotal(result.total);
    setOffset(start);
  }
  async function open(id: string) {
    const status = await api<{ url: string; callbackUrl: string; homeAssistantConnected: boolean }>(
      base + '/connection',
    );
    setConnection(status);
    setSettings(await api(base + '/settings'));
    await loadProfiles('', 0);
    setAuthenticated(true);
    if (id) {
      try {
        setPairingTarget(undefined);
        setPairing(await api(base + '/pairings/' + encodeURIComponent(id)));
      } catch (error) {
        notifyError(error instanceof Error ? error.message : 'La solicitud ha caducado.');
      }
    }
  }
  useEffect(() => {
    window.addEventListener('zero-session-expired', lock);
    return () => window.removeEventListener('zero-session-expired', lock);
  }, []);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('pairing') || '';
    setPairingId(id);
    api<{ setupRequired: boolean; authenticated: boolean; ingress: boolean }>('/api/auth/setup')
      .then(async (status) => {
        setSetupRequired(status.setupRequired);
        setIngress(status.ingress);
        if (status.authenticated) await open(id);
      })
      .catch((error) => notifyError(error))
      .finally(() => setChecking(false));
  }, []);
  const submit =
    (work: (data: FormData) => Promise<void>) => (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void run(() => work(data));
    };
  return (
    <div className="shell">
      <aside>
        <a className="brand" href={adminPath('/admin/')}>
          <img src={adminPath('/icon.png')} alt="" />
          <span>
            zero<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-label">TU ESPACIO</div>
        <nav aria-label="Administración">
          {navigation.map(({ id, label, Icon }) => (
            <Button
              key={id}
              className={tab === id ? 'nav active' : 'nav'}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => {
                setTab(id);
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
            </Button>
          ))}
        </nav>
        <div className="aside-bottom">
          <span className="live-dot" /> Zero, a tu manera
          <p>
            Una identidad.
            <br />
            Todas tus conversaciones.
          </p>
          <small>Configuración de tus asistentes y conexiones.</small>
        </div>
      </aside>
      <main>
        <header>
          <span className="breadcrumb">
            Tu espacio <span>/</span>{' '}
            {tab === 'people'
              ? 'Usuarios'
              : tab === 'settings'
                ? 'Asistentes'
                : tab === 'services'
                  ? 'Ajustes'
                  : tab === 'ai'
                    ? 'Proveedores IA'
                    : 'Seguridad'}
          </span>
          {authenticated && !ingress && (
            <Button
              className="quiet"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api('/api/auth/sign-out', 'POST', {});
                  lock();
                })
              }
              size="icon"
              tooltip="Cerrar sesión ↗"
            >
              <LogOut />
            </Button>
          )}
        </header>
        <div className="content">
          {checking ? (
            <p>Cargando tu espacio…</p>
          ) : setupRequired ? (
            <Card className="login panel">
              <h1>Configura tu Zero.</h1>
              <p>Crea la cuenta administradora de esta instalación para empezar.</p>
              <form
                onSubmit={submit(async (data) => {
                  if (data.get('password') !== data.get('confirmPassword'))
                    throw new Error('Las contraseñas no coinciden.');
                  const username = String(data.get('username')).toLowerCase();
                  const password = String(data.get('password'));
                  await api('/api/auth/setup', 'POST', { username, password });
                  setSetupRequired(false);
                  await api('/api/auth/sign-in/username', 'POST', {
                    username,
                    password,
                    rememberMe: true,
                  });
                  await open(pairingId);
                  setTab('services');
                  setNotice('Cuenta creada. Puedes configurar tus servicios ahora o más adelante.');
                })}
              >
                <Label>
                  Usuario administrador
                  <Input
                    name="username"
                    autoComplete="username"
                    minLength={3}
                    maxLength={32}
                    pattern="[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,31}"
                    required
                  />
                </Label>
                <Label>
                  Contraseña
                  <Input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                  />
                </Label>
                <Label>
                  Confirmar contraseña
                  <Input
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                  />
                </Label>
                <Button disabled={busy}>
                  Crear cuenta y empezar <ArrowRight />
                </Button>
              </form>
            </Card>
          ) : !authenticated && ingress ? (
            <Card className="login panel">
              <h1>Accede desde Home Assistant.</h1>
              <p>
                Abre Zero desde el panel de Home Assistant con una cuenta administradora. Las
                cuentas sin permisos de administración no pueden gestionar Zero.
              </p>
            </Card>
          ) : !authenticated ? (
            <Card className="login panel">
              <div className="eyebrow">BIENVENIDO A ZERO</div>
              <h1>
                Todo empieza <br />
                con una conexión.
              </h1>
              <p>
                Inicia sesión para configurar tu asistente
                {pairingId ? ' y aprobar la conexión desde Home Assistant' : ''}.
              </p>
              {!secondFactor && (
                <form
                  onSubmit={submit(async (data) => {
                    const result = await api<{ twoFactorRedirect?: boolean }>(
                      '/api/auth/sign-in/username',
                      'POST',
                      {
                        username: data.get('username'),
                        password: data.get('password'),
                        rememberMe: true,
                      },
                    );
                    if (result.twoFactorRedirect) {
                      setSecondFactor(true);
                      return;
                    }
                    await open(pairingId);
                  })}
                >
                  <Label>
                    Usuario
                    <Input name="username" autoComplete="username" required />
                  </Label>
                  <Label>
                    Contraseña
                    <Input
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </Label>
                  <Button disabled={busy} className="login-primary">
                    Entrar en Zero <ArrowRight />
                  </Button>
                </form>
              )}
              {secondFactor ? (
                <form
                  onSubmit={submit(async (data) => {
                    const code = String(data.get('code'));
                    if (backupCode)
                      authResult(await authClient.twoFactor.verifyBackupCode({ code }));
                    else authResult(await authClient.twoFactor.verifyTotp({ code }));
                    setSecondFactor(false);
                    await open(pairingId);
                  })}
                >
                  <Label>
                    {backupCode ? 'Código de recuperación de 2FA' : 'Código de la aplicación'}
                    <Input
                      key={String(backupCode)}
                      name="code"
                      autoComplete="one-time-code"
                      required
                    />
                  </Label>
                  <Button disabled={busy} className="login-primary">
                    <LogIn /> Verificar y entrar
                  </Button>
                  <div className="login-actions">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      className="login-alternative"
                      onClick={() => setBackupCode(!backupCode)}
                    >
                      <KeyRound /> {backupCode ? 'Usar aplicación' : 'Usar código de recuperación'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setSecondFactor(false);
                        setBackupCode(false);
                      }}
                      className="login-alternative"
                    >
                      <ArrowLeft /> Usar otro método
                    </Button>
                  </div>
                </form>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      authResult(await authClient.signIn.passkey());
                      await open(pairingId);
                    })
                  }
                  className="login-alternative"
                >
                  <LogIn /> Entrar con passkey
                </Button>
              )}
              <Button
                className="login-recovery-toggle"
                variant="link"
                onClick={() => setRecovery(!recovery)}
                aria-expanded={recovery}
                aria-controls="login-recovery"
              >
                <KeyRound /> {recovery ? 'Cerrar recuperación' : 'He olvidado mi contraseña'}
              </Button>
              {recovery && (
                <form
                  id="login-recovery"
                  className="login-recovery"
                  onSubmit={submit(async (data) => {
                    const result = await api<{ message: string }>(
                      '/api/auth/recovery/reset',
                      'POST',
                      { code: data.get('code'), password: data.get('password') },
                    );
                    setNotice(result.message);
                    setRecovery(false);
                  })}
                >
                  <p>
                    Recibe un código en tu destino privado de Telegram o en el móvil verificado de
                    Home Assistant.
                  </p>
                  <Label>
                    Usuario administrador
                    <Input
                      autoComplete="username"
                      value={recoveryUsername}
                      onChange={(event) => setRecoveryUsername(event.target.value)}
                      required
                    />
                  </Label>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !recoveryUsername}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{ message: string }>(
                          '/api/auth/recovery/request',
                          'POST',
                          { username: recoveryUsername },
                        );
                        setNotice(result.message);
                      })
                    }
                    className="login-alternative"
                  >
                    <Check /> Solicitar código
                  </Button>
                  <Label>
                    Código
                    <Input name="code" inputMode="numeric" pattern="[0-9]{8}" required />
                  </Label>
                  <Label>
                    Nueva contraseña
                    <Input
                      name="password"
                      type="password"
                      minLength={12}
                      maxLength={128}
                      autoComplete="new-password"
                      required
                    />
                  </Label>
                  <Button disabled={busy} className="login-primary">
                    <KeyRound /> Restablecer contraseña
                  </Button>
                </form>
              )}
            </Card>
          ) : (
            <>
              {pairing && (
                <Card className="pairing panel">
                  <div className="eyebrow">SOLICITUD DESDE HOME ASSISTANT</div>
                  <h2>Conecta tu casa con tu Zero.</h2>
                  <p>Comprueba que reconoces esta instancia antes de aprobar.</p>
                  <dl>
                    <dt>Home Assistant</dt>
                    <dd>{pairing.homeAssistantUrl}</dd>
                    <dt>Usuario de Home Assistant</dt>
                    <dd>
                      <code>{pairing.userId}</code>
                    </dd>
                    <dt>Solicitud válida hasta</dt>
                    <dd>{new Date(pairing.expiresAt).toLocaleTimeString('es-ES')}</dd>
                  </dl>
                  <form
                    onSubmit={submit(async () => {
                      const result = await api<{ redirectUrl: string }>(
                        base + '/pairings/' + pairing.id + '/approve',
                        'POST',
                        { chatId: pairingTarget?.chatId, bot: pairingTarget?.bot },
                      );
                      location.assign(result.redirectUrl);
                    })}
                  >
                    <PairingProfilePicker
                      pairingId={pairing.id}
                      selected={pairingTarget}
                      onSelect={setPairingTarget}
                    />
                    <p>
                      {pairingTarget?.kind === 'group'
                        ? 'Al aprobar, la conexión Home Assistant de este grupo se actualizará con un token cifrado. Sus herramientas y avisos usarán este servidor. Los vínculos privados de voz se gestionan por separado. Se conservan sus permisos actuales.'
                        : 'Al aprobar, Home Assistant creará un token de larga duración y Zero lo guardará cifrado en el perfil seleccionado, actualizando su conexión. Se generará un token de Zero para voz, ajustes y alertas. Se activará el permiso Home Assistant. Se conservan los demás permisos y la memoria del perfil.'}
                    </p>
                    <Button
                      disabled={busy || !pairingTarget || pairing.state !== 'pending'}
                      size="icon"
                      tooltip="Aprobar y volver a Home Assistant →"
                    >
                      <ArrowRight />
                    </Button>
                    <Button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        setPairing(undefined);
                        setEditingProfile(undefined);
                        history.replaceState(null, '', adminPath('/admin/'));
                      }}
                      size="icon"
                      tooltip="Ahora no"
                    >
                      <X />
                    </Button>
                  </form>
                  <small>
                    Solo aparecen usuarios y grupos activos de tus asistentes; puedes activarlos en
                    Usuarios.
                  </small>
                </Card>
              )}
              {editingProfile !== undefined && (
                <ProfileEditor
                  key={editingProfile ? editingProfile.bot + editingProfile.chatId : 'new'}
                  profile={editingProfile}
                  timezone={defaultTimezone}
                  onClose={() => setProfileRoute('')}
                  onCreated={(profile) =>
                    setProfileRoute(profile.bot + '/' + encodeURIComponent(profile.chatId))
                  }
                  onChanged={async (message) => {
                    await loadProfiles();
                    setConnection(await api(base + '/connection'));
                    if (message) setNotice(message);
                  }}
                />
              )}
              {tab === 'people' && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">PERMISOS Y MEMORIA</div>
                      <h1>Usuarios y permisos.</h1>
                      <p>
                        Las vinculaciones de Home Assistant usan los mismos permisos y
                        conversaciones de Zero.
                      </p>
                    </div>
                    <Button
                      onClick={() => setProfileRoute('new')}
                      size="icon"
                      tooltip="Añadir usuario o grupo"
                    >
                      <Plus />
                    </Button>
                  </div>
                  <Card className="panel">
                    <form
                      className="search-row"
                      onSubmit={submit(async (data) => {
                        const q = String(data.get('search') || '');
                        setSearch(q);
                        await loadProfiles(q, 0);
                      })}
                    >
                      <Input
                        aria-label="Buscar perfiles"
                        name="search"
                        placeholder="Buscar por nombre o chat ID"
                      />
                      <Button disabled={busy} className="secondary" size="icon" tooltip="Buscar">
                        <Search />
                      </Button>
                    </form>
                    <CheckField
                      id="people-pending"
                      label="Solo pendientes"
                      checked={pending}
                      disabled={busy}
                      onCheckedChange={(value) => {
                        const enabled = value === true;
                        setPending(enabled);
                        void run(() => loadProfiles(search, 0, enabled));
                      }}
                    />
                    <div className="profile-list">
                      {profiles.map((p) => (
                        <div className="profile-row person-row" key={p.bot + p.chatId}>
                          <div className="person-summary">
                            <TelegramAvatar profile={p} />
                            <div className="person-details">
                              <strong className="person-name">
                                <span>{p.label}</span>
                                {(p.hasHomeAssistant || p.source === 'home_assistant') && (
                                  <HomeAssistantIndicator />
                                )}
                              </strong>
                              <small>
                                {p.source === 'home_assistant' ? (
                                  'Home Assistant'
                                ) : (
                                  <AssistantConnectionName id={p.bot} />
                                )}{' '}
                                · {p.chatId} · {p.kind === 'user' ? 'Privado' : 'Grupo'}
                              </small>
                            </div>
                          </div>
                          <div className="person-actions">
                            <Badge variant="outline" className="pill">
                              {p.enabled ? 'Activo' : 'Pendiente'}
                            </Badge>
                            <AssistantAssignment profile={p} onAssigned={() => loadProfiles()} />
                            <Button
                              variant="outline"
                              onClick={() =>
                                setProfileRoute(p.bot + '/' + encodeURIComponent(p.chatId))
                              }
                              aria-label={'Editar perfil de ' + p.label}
                              size="icon"
                              tooltip="Editar perfil"
                            >
                              <Pencil />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {!profiles.length && <p>No hay perfiles con esta búsqueda.</p>}
                    <div className="pager">
                      <Button
                        className="quiet"
                        disabled={busy || offset === 0}
                        onClick={() =>
                          void run(() => loadProfiles(search, Math.max(0, offset - 20)))
                        }
                        size="icon"
                        tooltip="← Anterior"
                      >
                        <ArrowLeft />
                      </Button>
                      <small>
                        {offset + 1}–{Math.min(offset + 20, total)} de {total}
                      </small>
                      <Button
                        className="quiet"
                        disabled={busy || offset + 20 >= total}
                        onClick={() => void run(() => loadProfiles(search, offset + 20))}
                        size="icon"
                        tooltip="Siguiente →"
                      >
                        <ArrowRight />
                      </Button>
                    </div>
                  </Card>
                  {settings && connection?.homeAssistantConnected && (
                    <Card className="panel">
                      <h2>Usuarios de Home Assistant</h2>
                      {Object.entries(settings.homeAssistantUsers || {}).map(([user, chat]) => (
                        <div className="profile-row" key={user}>
                          <code>{user}</code>
                          <span>→ {chat}</span>
                          <Button
                            className="quiet"
                            disabled={busy}
                            onClick={() =>
                              void run(async () =>
                                setSettings(
                                  await api(base + '/users', 'PUT', {
                                    revision: settings.revision,
                                    userId: user,
                                    chatId: null,
                                  }),
                                ),
                              )
                            }
                            size="icon"
                            tooltip="Desvincular"
                          >
                            <Unlink />
                          </Button>
                        </div>
                      ))}
                      <p>
                        La vinculación se crea al aprobar la configuración desde Home Assistant.
                        También puedes gestionarla en las opciones de la integración.
                      </p>
                    </Card>
                  )}
                </>
              )}
              {tab === 'settings' && settings && (
                <AssistantCatalog
                  onZeroChanged={async () => setSettings(await api(base + '/settings'))}
                />
              )}
              {tab === 'services' && <ServiceSettings onSkip={() => setTab('settings')} />}
              {tab === 'ai' && <AISettingsEditor />}
              {tab === 'security' && (
                <>
                  {ingress ? (
                    <Card className="panel">
                      <h2>Administración desde Home Assistant</h2>
                      <p>
                        Tu acceso, contraseña y autenticación se gestionan en Home Assistant. Puedes
                        configurar los servicios de Zero en Ajustes y los perfiles en Usuarios.
                      </p>
                    </Card>
                  ) : (
                    <AccountSettings />
                  )}
                </>
              )}
            </>
          )}
          <footer>
            ZERO ASSISTANT <span>Hecho para tu día a día.</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
