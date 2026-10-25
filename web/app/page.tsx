'use client';
import { useEffect, useState, useRef, type FormEvent } from 'react';
import {
  api,
  SessionExpired,
  type Profile,
  type Credential,
  type Settings,
  type Pairing,
} from '../lib/api';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Checkbox } from '../components/ui/checkbox';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { RevokeToken } from '../components/revoke-token';
import { AssistantCatalog } from '../components/assistant-catalog';
import { AssistantAssignment } from '../components/assistant-assignment';
import { Link2, Users, Sparkles, ShieldCheck, House } from 'lucide-react';
const base = '/v1/admin/setup';
const navigation = [
  { id: 'connections', label: 'Conexiones', Icon: Link2 },
  { id: 'people', label: 'Personas', Icon: Users },
  { id: 'settings', label: 'Asistentes', Icon: Sparkles },
  { id: 'security', label: 'Seguridad', Icon: ShieldCheck },
];
const date = (value: string) => new Date(value).toLocaleDateString('es-ES');
export default function Home() {
  const [authenticated, setAuthenticated] = useState(false),
    [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState('connections');
  const [profiles, setProfiles] = useState<Profile[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [search, setSearch] = useState('');
  const [tokens, setTokens] = useState<Credential[]>([]),
    [tokenTotal, setTokenTotal] = useState(0),
    [tokenOffset, setTokenOffset] = useState(0),
    [issued, setIssued] = useState<Credential>();
  const [settings, setSettings] = useState<Settings>(),
    [connection, setConnection] = useState<{ url: string; callbackUrl: string }>();
  const [pairing, setPairing] = useState<Pairing>(),
    [pairingId, setPairingId] = useState(''),
    [selected, setSelected] = useState('');
  const [recovery, setRecovery] = useState(false);
  const running = useRef(false);
  function lock() {
    setAuthenticated(false);
    setProfiles([]);
    setTokens([]);
    setIssued(undefined);
    setSettings(undefined);
    setPairing(undefined);
  }
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice('');
    try {
      await work();
    } catch (error) {
      if (error instanceof SessionExpired) lock();
      setNotice(error instanceof Error ? error.message : 'No se pudo completar la operación.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function loadProfiles(query = search, start = offset) {
    const result = await api<{ items: Profile[]; total: number }>(
      '/v1/admin/profiles?limit=20&offset=' + start + '&search=' + encodeURIComponent(query),
    );
    setProfiles(result.items);
    setTotal(result.total);
    setOffset(start);
  }
  async function loadTokens(start = tokenOffset) {
    const result = await api<{ items: Credential[]; total: number }>(
      base + '/tokens?limit=20&offset=' + start,
    );
    setTokens(result.items);
    setTokenTotal(result.total);
    setTokenOffset(start);
  }
  async function open(id: string) {
    setConnection(await api(base + '/connection'));
    setSettings(await api(base + '/settings'));
    await loadProfiles('', 0);
    await loadTokens(0);
    setAuthenticated(true);
    if (id) {
      try {
        setPairing(await api(base + '/pairings/' + encodeURIComponent(id)));
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'La solicitud ha caducado.');
      }
    }
  }
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('pairing') || '';
    setPairingId(id);
    api<{ user?: { username?: string } }>('/api/auth/get-session')
      .then(async (session) => {
        if (session?.user?.username === 'fixt') await open(id);
      })
      .catch((error) => setNotice(error.message))
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
        <a className="brand" href="/admin/">
          <img src="/icon.png" alt="" />
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
                setIssued(undefined);
              }}
            >
              <Icon size={18} />
              {label}
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
          <a href="/admin/advanced">Administración avanzada ↗</a>
        </div>
      </aside>
      <main>
        <header>
          <span className="breadcrumb">
            Tu espacio <span>/</span>{' '}
            {tab === 'connections'
              ? 'Conexiones'
              : tab === 'people'
                ? 'Personas'
                : tab === 'settings'
                  ? 'Asistentes'
                  : 'Seguridad'}
          </span>
          {authenticated && (
            <Button
              className="quiet"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api('/api/auth/sign-out', 'POST', {});
                  lock();
                })
              }
            >
              Cerrar sesión ↗
            </Button>
          )}
        </header>
        <div className="content">
          <div role="status" aria-live="polite" className={notice ? 'notice' : 'hidden'}>
            {notice}
          </div>
          {checking ? (
            <p>Cargando tu espacio…</p>
          ) : !authenticated ? (
            <Card className="login panel">
              <div className="eyebrow">BIENVENIDO A ZERO</div>
              <h1>
                Todo empieza
                <br />
                con una conexión.
              </h1>
              <p>
                Inicia sesión para configurar tu asistente
                {pairingId ? ' y aprobar la conexión desde Home Assistant' : ''}.
              </p>
              <form
                onSubmit={submit(async (data) => {
                  await api('/api/auth/sign-in/username', 'POST', {
                    username: data.get('username'),
                    password: data.get('password'),
                    rememberMe: true,
                  });
                  await open(pairingId);
                })}
              >
                <Label>
                  Usuario
                  <Input name="username" autoComplete="username" defaultValue="fixt" required />
                </Label>
                <Label>
                  Contraseña
                  <Input name="password" type="password" autoComplete="current-password" required />
                </Label>
                <Button disabled={busy}>Entrar en Zero →</Button>
              </form>
              <Button className="quiet" onClick={() => setRecovery(!recovery)}>
                He olvidado mi contraseña
              </Button>
              {recovery && (
                <form
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
                    Recibe un código en el Telegram del administrador si la recuperación está
                    activada.
                  </p>
                  <Button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{ message: string }>(
                          '/api/auth/recovery/request',
                          'POST',
                          { username: 'fixt' },
                        );
                        setNotice(result.message);
                      })
                    }
                  >
                    Solicitar código
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
                  <Button disabled={busy}>Restablecer contraseña</Button>
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
                        { chatId: selected },
                      );
                      location.assign(result.redirectUrl);
                    })}
                  >
                    <Label>
                      Vincular a la persona de Zero
                      <select
                        value={selected}
                        onChange={(e) => setSelected(e.target.value)}
                        required
                      >
                        <option value="">Selecciona un perfil privado activo</option>
                        {profiles
                          .filter((p) => p.bot === 'zero' && p.kind === 'user' && p.enabled)
                          .map((p) => (
                            <option key={p.chatId} value={p.chatId}>
                              {p.label} · {p.chatId}
                            </option>
                          ))}
                      </select>
                    </Label>
                    <p>
                      Al aprobar, Home Assistant creará un token de larga duración y Zero lo
                      guardará cifrado en este perfil. Se generará un token de Zero para voz,
                      ajustes y alertas. El usuario conservará los permisos y la memoria del perfil
                      seleccionado.
                    </p>
                    <Button disabled={busy || pairing.state !== 'pending'}>
                      Aprobar y volver a Home Assistant →
                    </Button>
                    <Button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        setPairing(undefined);
                        history.replaceState(null, '', '/admin/');
                      }}
                    >
                      Ahora no
                    </Button>
                  </form>
                  <small>
                    Si tu perfil no aparece, búscalo en Personas o créalo en la administración
                    avanzada.
                  </small>
                </Card>
              )}
              {tab === 'connections' && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">UN ZERO. MÁS POSIBILIDADES.</div>
                      <h1>Tu mundo, conectado.</h1>
                      <p>Conecta los servicios que hacen tu día más fácil.</p>
                    </div>
                    <span className="pill">Configuración de Zero</span>
                  </div>
                  <Card className="hero panel">
                    <div className="ha-mark">
                      <House size={32} />
                    </div>
                    <div>
                      <span className="eyebrow">HOME ASSISTANT</span>
                      <h2>Tu casa. Una conversación.</h2>
                      <p>
                        Añade la instancia de Zero descubierta en Home Assistant. El asistente de
                        configuración te traerá aquí para aprobar la conexión y compartirá las
                        credenciales automáticamente.
                      </p>
                      <div className="steps">
                        <span>
                          <b>01</b> Descubre Zero
                        </span>
                        <span>
                          <b>02</b> Aprueba la conexión
                        </span>
                        <span>
                          <b>03</b> Empieza a hablar
                        </span>
                      </div>
                      <a
                        className="button"
                        href="https://my.home-assistant.io/redirect/integrations/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Abrir Home Assistant ↗
                      </a>
                    </div>
                  </Card>
                  <div className="two-columns">
                    <Card className="panel">
                      <span className="eyebrow">CONEXIÓN LOCAL</span>
                      <h2>Zero ya sabe presentarse.</h2>
                      <p>
                        Home Assistant detecta Zero mediante mDNS en la misma red. Comprueba que
                        esta URL es accesible desde Home Assistant.
                      </p>
                      <Label>
                        URL de Zero
                        <Input readOnly value={connection?.url || ''} />
                      </Label>
                      <small>
                        La detección anuncia la dirección del servidor. La aprobación comparte las
                        credenciales por separado.
                      </small>
                    </Card>
                    <Card className="panel">
                      <span className="eyebrow">TUS OTRAS CONEXIONES</span>
                      <h2>Cada persona, su espacio.</h2>
                      <p>
                        Gestiona Google, Telegram, entidades de tu casa y voz por perfil. Los
                        secretos guardados se conservan cuando dejas sus campos vacíos.
                      </p>
                      <a className="text-link" href="/admin/advanced">
                        Configurar servicios y perfiles ↗
                      </a>
                    </Card>
                  </div>
                </>
              )}
              {tab === 'people' && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">PERMISOS Y MEMORIA</div>
                      <h1>Un espacio para cada persona.</h1>
                      <p>
                        Las vinculaciones de Home Assistant usan los mismos permisos y
                        conversaciones de Zero.
                      </p>
                    </div>
                    <a className="button" href="/admin/advanced">
                      Gestionar perfiles ↗
                    </a>
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
                      <Button disabled={busy} className="secondary">
                        Buscar
                      </Button>
                    </form>
                    <div className="profile-list">
                      {profiles.map((p) => (
                        <div className="profile-row" key={p.bot + p.chatId}>
                          <span className="avatar">{p.label.slice(0, 1).toUpperCase()}</span>
                          <div>
                            <strong>{p.label}</strong>
                            <small>
                              {p.bot} · {p.chatId} · {p.kind === 'user' ? 'Privado' : 'Grupo'}
                            </small>
                          </div>
                          <Badge variant="outline" className="pill">
                            {p.enabled ? 'Activo' : 'Pendiente'}
                          </Badge>
                          <AssistantAssignment profile={p} onAssigned={() => loadProfiles()} />
                          {p.hasHomeAssistant && (
                            <span className="pill connected">Home Assistant</span>
                          )}
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
                      >
                        ← Anterior
                      </Button>
                      <small>
                        {offset + 1}–{Math.min(offset + 20, total)} de {total}
                      </small>
                      <Button
                        className="quiet"
                        disabled={busy || offset + 20 >= total}
                        onClick={() => void run(() => loadProfiles(search, offset + 20))}
                      >
                        Siguiente →
                      </Button>
                    </div>
                  </Card>
                  {settings && (
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
                          >
                            Desvincular
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
                <>
                  <AssistantCatalog
                    onZeroChanged={async () => setSettings(await api(base + '/settings'))}
                  />
                  <h2>Permisos compartidos de Home Assistant</h2>
                  <p>
                    Estos ajustes de acceso se conservan en Zero y también se pueden gestionar desde
                    Home Assistant.
                  </p>
                  <form
                    className="panel"
                    onSubmit={submit(async (data) => {
                      const saved = await api<Settings>(base + '/settings', 'PUT', {
                        revision: settings.revision,
                        prompt: settings.prompt,
                        homeAssistant: data.has('homeAssistant'),
                        assist: data.has('assist'),
                        frigate: data.has('frigate'),
                        services: String(data.get('services') || '')
                          .split('\n')
                          .map((v) => v.trim())
                          .filter(Boolean),
                      });
                      setSettings(saved);
                      setNotice('Configuración guardada.');
                    })}
                    key={settings.revision}
                  >
                    <div className="toggle-list">
                      {[
                        ['homeAssistant', 'Herramientas de Home Assistant'],
                        ['assist', 'Delegación a Assist'],
                        ['frigate', 'Servicios de Frigate'],
                      ].map(([id, label]) => (
                        <Label className="check" key={id}>
                          <Checkbox name={id} defaultChecked={!!settings[id as keyof Settings]} />
                          {label}
                        </Label>
                      ))}
                    </div>
                    <Label>
                      Servicios permitidos
                      <Textarea
                        name="services"
                        defaultValue={settings.services.join('\n')}
                        rows={4}
                        placeholder="light.turn_on"
                      />
                    </Label>
                    <small>
                      Un servicio domain.service por línea. Los recordatorios existentes conservan
                      sus horarios.
                    </small>
                    <div className="form-actions">
                      <Button disabled={busy}>Guardar ajustes →</Button>
                      <Button
                        type="button"
                        className="quiet"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => setSettings(await api(base + '/settings')))
                        }
                      >
                        Recargar
                      </Button>
                    </div>
                  </form>
                </>
              )}
              {tab === 'security' && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">CONTROL DE ACCESO</div>
                      <h1>Conexiones bajo tu control.</h1>
                      <p>Consulta y revoca los tokens de tus integraciones cuando lo necesites.</p>
                    </div>
                  </div>
                  <Card className="panel">
                    <h2>Tokens de Home Assistant</h2>
                    <p>
                      La configuración guiada los genera automáticamente. También puedes crear uno
                      para una conexión manual. Solo permite voz, ajustes y eventos de alertas.
                    </p>
                    <form
                      className="search-row"
                      onSubmit={submit(async (data) => {
                        setIssued(
                          await api<Credential>(base + '/tokens', 'POST', {
                            name: data.get('name'),
                            days: Number(data.get('days')),
                          }),
                        );
                        await loadTokens(0);
                      })}
                    >
                      <Input
                        name="name"
                        aria-label="Nombre del token"
                        placeholder="Nombre de la conexión"
                        maxLength={100}
                        required
                      />
                      <select name="days" aria-label="Validez">
                        <option value="365">1 año</option>
                        <option value="3650">10 años</option>
                        <option value="30">30 días</option>
                      </select>
                      <Button disabled={busy}>Crear token</Button>
                    </form>
                    {issued?.token && (
                      <div className="secret">
                        <strong>Guárdalo ahora. Solo se muestra una vez.</strong>
                        <p>
                          Pega este token en los campos de voz, ajustes y callback de la conexión
                          manual.
                        </p>
                        <Textarea readOnly aria-label="Nuevo token" value={issued.token} />
                        <Button className="quiet" onClick={() => setIssued(undefined)}>
                          Ocultar token
                        </Button>
                      </div>
                    )}
                    {tokens.map((token) => (
                      <div className="profile-row" key={token.id}>
                        <div>
                          <strong>{token.name}</strong>
                          <small>
                            Caduca {date(token.expiresAt)} ·{' '}
                            {token.revokedAt ? 'Revocado' : 'Emitido'}
                          </small>
                        </div>
                        <RevokeToken
                          name={token.name}
                          disabled={busy || !!token.revokedAt}
                          onRevoke={() =>
                            void run(async () => {
                              await api(base + '/tokens/' + token.id, 'DELETE');
                              setIssued(undefined);
                              await loadTokens();
                            })
                          }
                        />
                      </div>
                    ))}
                    <div className="pager">
                      <Button
                        className="quiet"
                        disabled={busy || !tokenOffset}
                        onClick={() => void run(() => loadTokens(Math.max(0, tokenOffset - 20)))}
                      >
                        ← Anterior
                      </Button>
                      <small>{tokenTotal} tokens</small>
                      <Button
                        className="quiet"
                        disabled={busy || tokenOffset + 20 >= tokenTotal}
                        onClick={() => void run(() => loadTokens(tokenOffset + 20))}
                      >
                        Siguiente →
                      </Button>
                    </div>
                    <small>
                      Los tokens anteriores a esta pantalla se mantienen para conservar las
                      conexiones existentes.
                    </small>
                  </Card>
                  <Card className="panel">
                    <h2>Contraseña y recuperación</h2>
                    <p>
                      Actualiza tu contraseña o configura la recuperación por Telegram en los
                      ajustes de cuenta.
                    </p>
                    <a className="text-link" href="/admin/advanced">
                      Abrir ajustes de cuenta ↗
                    </a>
                  </Card>
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
