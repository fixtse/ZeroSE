'use client';
import { LanguageSelector } from '../components/language-selector';
import { useTranslations } from '../i18n/provider';
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
import { HomeAssistantUsers } from '../components/home-assistant-users';
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
  const t = useTranslations();
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
      notifyError(error instanceof Error ? error.message : t('No se pudo completar la operación.'));
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
        notifyError(error instanceof Error ? error.message : t('La solicitud ha caducado.'));
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
        <div className="workspace-label">{t('TU ESPACIO')}</div>
        <nav aria-label={t('Administración')}>
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
              <span>{t(label)}</span>
            </Button>
          ))}
        </nav>
        <div className="aside-bottom">
          <span className="live-dot" /> {t('Zero, a tu manera')}
          <p>
            {t('Una identidad.')}
            <br />
            {t('Todas tus conversaciones.')}
          </p>
          <small>{t('Configuración de tus asistentes y conexiones.')}</small>
        </div>
      </aside>
      <main>
        <header>
          <span className="breadcrumb">
            {t('Tu espacio')} <span>/</span>{' '}
            {tab === 'people'
              ? t('Usuarios')
              : tab === 'settings'
                ? t('Asistentes')
                : tab === 'services'
                  ? t('Ajustes')
                  : tab === 'ai'
                    ? t('Proveedores IA')
                    : t('Seguridad')}
          </span>
          <LanguageSelector />
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
              tooltip={t('Cerrar sesión ↗')}
            >
              <LogOut />
            </Button>
          )}
        </header>
        <div className="content">
          {checking ? (
            <p>{t('Cargando tu espacio…')}</p>
          ) : setupRequired ? (
            <Card className="login panel">
              <h1>{t('Configura tu Zero.')}</h1>
              <p>{t('Crea la cuenta administradora de esta instalación para empezar.')}</p>
              <form
                onSubmit={submit(async (data) => {
                  if (data.get('password') !== data.get('confirmPassword'))
                    throw new Error(t('Las contraseñas no coinciden.'));
                  const username = String(data.get('username')).toLowerCase();
                  const password = String(data.get('password'));
                  await api('/api/auth/setup', 'POST', { username, password, language: t.locale });
                  setSetupRequired(false);
                  await api('/api/auth/sign-in/username', 'POST', {
                    username,
                    password,
                    rememberMe: true,
                  });
                  await open(pairingId);
                  setTab('services');
                  setNotice(
                    t('Cuenta creada. Puedes configurar tus servicios ahora o más adelante.'),
                  );
                })}
              >
                <Label>
                  {t('Usuario administrador')}
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
                  {t('Contraseña')}
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
                  {t('Confirmar contraseña')}
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
                  {t('Crear cuenta y empezar')} <ArrowRight />
                </Button>
              </form>
            </Card>
          ) : !authenticated && ingress ? (
            <Card className="login panel">
              <h1>{t('Accede desde Home Assistant.')}</h1>
              <p>
                {t(
                  'Abre Zero desde el panel de Home Assistant con una cuenta administradora. Las cuentas sin permisos de administración no pueden gestionar Zero.',
                )}
              </p>
            </Card>
          ) : !authenticated ? (
            <Card className="login panel">
              <div className="eyebrow">{t('BIENVENIDO A ZERO')}</div>
              <h1>
                {t('Todo empieza')} <br />
                {t('con una conexión.')}
              </h1>
              <p>
                {t('Inicia sesión para configurar tu asistente')}
                {pairingId ? t(' y aprobar la conexión desde Home Assistant') : ''}.
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
                    {t('Usuario')}
                    <Input name="username" autoComplete="username" required />
                  </Label>
                  <Label>
                    {t('Contraseña')}
                    <Input
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </Label>
                  <Button disabled={busy} className="login-primary">
                    {t('Entrar en Zero')} <ArrowRight />
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
                    {backupCode ? t('Código de recuperación de 2FA') : t('Código de la aplicación')}
                    <Input
                      key={String(backupCode)}
                      name="code"
                      autoComplete="one-time-code"
                      required
                    />
                  </Label>
                  <Button disabled={busy} className="login-primary">
                    <LogIn /> {t('Verificar y entrar')}
                  </Button>
                  <div className="login-actions">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      className="login-alternative"
                      onClick={() => setBackupCode(!backupCode)}
                    >
                      <KeyRound />{' '}
                      {backupCode ? t('Usar aplicación') : t('Usar código de recuperación')}
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
                      <ArrowLeft /> {t('Usar otro método')}
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
                  <LogIn /> {t('Entrar con passkey')}
                </Button>
              )}
              <Button
                className="login-recovery-toggle"
                variant="link"
                onClick={() => setRecovery(!recovery)}
                aria-expanded={recovery}
                aria-controls="login-recovery"
              >
                <KeyRound /> {recovery ? t('Cerrar recuperación') : t('He olvidado mi contraseña')}
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
                    {t(
                      'Recibe un código en tu destino privado de Telegram o en el móvil verificado de Home Assistant.',
                    )}
                  </p>
                  <Label>
                    {t('Usuario administrador')}
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
                    <Check /> {t('Solicitar código')}
                  </Button>
                  <Label>
                    {t('Código')}
                    <Input name="code" inputMode="numeric" pattern="[0-9]{8}" required />
                  </Label>
                  <Label>
                    {t('Nueva contraseña')}
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
                    <KeyRound /> {t('Restablecer contraseña')}
                  </Button>
                </form>
              )}
            </Card>
          ) : (
            <>
              {pairing && (
                <Card className="pairing panel">
                  <div className="eyebrow">{t('SOLICITUD DESDE HOME ASSISTANT')}</div>
                  <h2>{t('Conecta tu casa con tu Zero.')}</h2>
                  <p>{t('Comprueba que reconoces esta instancia antes de aprobar.')}</p>
                  <dl>
                    <dt>Home Assistant</dt>
                    <dd>{pairing.homeAssistantUrl}</dd>
                    <dt>{t('Usuario de Home Assistant')}</dt>
                    <dd>
                      <code>{pairing.userId}</code>
                    </dd>
                    <dt>{t('Solicitud válida hasta')}</dt>
                    <dd>{new Date(pairing.expiresAt).toLocaleTimeString(t.locale)}</dd>
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
                        ? t(
                            'Al aprobar, la conexión Home Assistant de este grupo se actualizará con un token cifrado. Sus herramientas y avisos usarán este servidor. Los vínculos privados de voz se gestionan por separado. Se conservan sus permisos actuales.',
                          )
                        : t(
                            'Al aprobar, Home Assistant creará un token de larga duración y Zero lo guardará cifrado en el perfil seleccionado, actualizando su conexión. Se generará un token de Zero para voz, ajustes y alertas. Se activará el permiso Home Assistant. Se conservan los demás permisos y la memoria del perfil.',
                          )}
                    </p>
                    <Button
                      disabled={busy || !pairingTarget || pairing.state !== 'pending'}
                      size="icon"
                      tooltip={t('Aprobar y volver a Home Assistant →')}
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
                      tooltip={t('Ahora no')}
                    >
                      <X />
                    </Button>
                  </form>
                  <small>
                    {t(
                      'Solo aparecen usuarios y grupos activos de tus asistentes; puedes activarlos en Usuarios.',
                    )}
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
                      <div className="eyebrow">{t('PERMISOS Y MEMORIA')}</div>
                      <h1>{t('Usuarios y permisos.')}</h1>
                      <p>
                        {t(
                          'Las vinculaciones de Home Assistant usan los mismos permisos y conversaciones de Zero.',
                        )}
                      </p>
                    </div>
                    <Button
                      onClick={() => setProfileRoute('new')}
                      size="icon"
                      tooltip={t('Añadir usuario o grupo')}
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
                        aria-label={t('Buscar perfiles')}
                        name="search"
                        placeholder={t('Buscar por nombre o chat ID')}
                      />
                      <Button
                        disabled={busy}
                        className="secondary"
                        size="icon"
                        tooltip={t('Buscar')}
                      >
                        <Search />
                      </Button>
                    </form>
                    <CheckField
                      id="people-pending"
                      label={t('Solo pendientes')}
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
                                · {p.chatId} · {p.kind === 'user' ? t('Privado') : t('Grupo')}
                              </small>
                            </div>
                          </div>
                          <div className="person-actions">
                            <Badge variant="outline" className="pill">
                              {p.enabled ? t('Activo') : t('Pendiente')}
                            </Badge>
                            <AssistantAssignment profile={p} onAssigned={() => loadProfiles()} />
                            <Button
                              variant="outline"
                              onClick={() =>
                                setProfileRoute(p.bot + '/' + encodeURIComponent(p.chatId))
                              }
                              aria-label={t('Editar perfil de ') + p.label}
                              size="icon"
                              tooltip={t('Editar perfil')}
                            >
                              <Pencil />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {!profiles.length && <p>{t('No hay perfiles con esta búsqueda.')}</p>}
                    <div className="pager">
                      <Button
                        className="quiet"
                        disabled={busy || offset === 0}
                        onClick={() =>
                          void run(() => loadProfiles(search, Math.max(0, offset - 20)))
                        }
                        size="icon"
                        tooltip={t('← Anterior')}
                      >
                        <ArrowLeft />
                      </Button>
                      <small>
                        {offset + 1}–{Math.min(offset + 20, total)} {t('de')} {total}
                      </small>
                      <Button
                        className="quiet"
                        disabled={busy || offset + 20 >= total}
                        onClick={() => void run(() => loadProfiles(search, offset + 20))}
                        size="icon"
                        tooltip={t('Siguiente →')}
                      >
                        <ArrowRight />
                      </Button>
                    </div>
                  </Card>
                  {settings && connection?.homeAssistantConnected && (
                    <HomeAssistantUsers
                      settings={settings}
                      busy={busy}
                      onEdit={setProfileRoute}
                      onUnlink={(userId) =>
                        void run(async () => {
                          await api(base + '/users', 'PUT', {
                            revision: settings.revision,
                            userId,
                            chatId: null,
                          });
                          setSettings(await api(base + '/settings'));
                        })
                      }
                    />
                  )}
                </>
              )}
              {tab === 'settings' && settings && (
                <AssistantCatalog
                  onZeroChanged={async () => setSettings(await api(base + '/settings'))}
                />
              )}
              {tab === 'services' && <ServiceSettings />}
              {tab === 'ai' && <AISettingsEditor />}
              {tab === 'security' && (
                <>
                  {ingress ? (
                    <Card className="panel">
                      <h2>{t('Administración desde Home Assistant')}</h2>
                      <p>
                        {t(
                          'Tu acceso, contraseña y autenticación se gestionan en Home Assistant. Puedes configurar los servicios de Zero en Ajustes y los perfiles en Usuarios.',
                        )}
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
            ZERO ASSISTANT <span>{t('Hecho para tu día a día.')}</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
