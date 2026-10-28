import type { CredentialCrypto } from './integration-access.js';
import type { ServiceConfig, ServiceSettingsPort } from './service-settings.js';

export interface SchedulerPairingPort {
  begin(
    url: string,
    input: {
      id: string;
      secretHash: string;
      tokenHash: string;
      callbackUrl: string;
      callbackAuthorization: string;
    },
  ): Promise<void>;
  status(
    url: string,
    id: string,
    secret: string,
  ): Promise<'pending' | 'approved' | 'revoked' | 'expired'>;
  ready(config: NonNullable<ServiceConfig['schedulerSE']>): Promise<void>;
}
interface Pending {
  id: string;
  secret: string;
  config: NonNullable<ServiceConfig['schedulerSE']>;
  previous: string;
  expiresAt: number;
  state: 'pending' | 'checking' | 'saving' | 'uncertain' | 'configured';
}
function origin(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Introduce la URL del servicio sin rutas, credenciales ni parámetros.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error(
      'Usa HTTPS para intercambiar credenciales en la red. HTTP solo se admite en loopback.',
    );
  return url.origin;
}
/** One bounded, short-lived handshake. Credentials stay on the server. Refreshing
 * the admin page recovers this state; restarting Zero expires the local request. */
export class SchedulerSEPairing {
  private pending?: Pending;
  constructor(
    private settings: ServiceSettingsPort,
    private remote: SchedulerPairingPort,
    private crypto: CredentialCrypto,
    private callbackAuthorization: string,
    private publicUrl: string,
    private now = () => Date.now(),
  ) {}
  async begin(url: string) {
    url = origin(url);
    const current = await this.settings.read();
    if (current.value.schedulerSE?.token)
      throw new Error(
        'SchedulerSE ya tiene credenciales guardadas. Se ha conservado la conexión actual.',
      );
    if (this.pending && this.pending.expiresAt > this.now() && this.pending.state !== 'configured')
      throw new Error('Ya hay una solicitud en curso. Consulta su estado antes de iniciar otra.');
    const callbackUrl = origin(this.publicUrl) + '/v1/triggers/schedulerse-events';
    const pending: Pending = {
      id: this.crypto.id(),
      secret: this.crypto.secret(),
      config: { url, token: 'sse_' + this.crypto.secret(), callbackUrl, enabled: true },
      previous: JSON.stringify(current.value.schedulerSE),
      expiresAt: this.now() + 300000,
      state: 'pending',
    };
    // Retain the read handle before registration. A lost POST response is inspected
    // through GET, never by registering the request again.
    this.pending = pending;
    await this.remote.begin(url, {
      id: pending.id,
      secretHash: this.crypto.digest(pending.secret),
      tokenHash: this.crypto.digest(pending.config.token),
      callbackUrl,
      callbackAuthorization: this.callbackAuthorization,
    });
    return this.details(pending, 'pending');
  }
  private details(pending: Pending, state: string) {
    return {
      id: pending.id,
      state,
      serviceUrl: pending.config.url,
      callbackUrl: pending.config.callbackUrl,
      approvalUrl: pending.config.url + '/pairing/' + pending.id,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }
  async status() {
    const pending = this.pending;
    if (!pending) return { state: 'idle' };
    if (['saving', 'uncertain', 'configured'].includes(pending.state)) {
      const current = await this.settings.read();
      if (JSON.stringify(current.value.schedulerSE) === JSON.stringify(pending.config))
        pending.state = 'configured';
      return this.details(pending, pending.state);
    }
    if (pending.expiresAt <= this.now()) return this.details(pending, 'expired');
    return this.details(
      pending,
      await this.remote.status(pending.config.url, pending.id, pending.secret),
    );
  }
  async finish() {
    const pending = this.pending;
    if (!pending || pending.expiresAt <= this.now())
      throw new Error('La solicitud ha caducado. Inicia una nueva conexión.');
    if (pending.state !== 'pending')
      throw new Error('Consulta el estado de la operación anterior antes de continuar.');
    pending.state = 'checking';
    try {
      const state = await this.remote.status(pending.config.url, pending.id, pending.secret);
      if (state !== 'approved') throw new Error('Aprueba primero la solicitud en SchedulerSE.');
      await this.remote.ready(pending.config);
      const current = await this.settings.read();
      if (JSON.stringify(current.value.schedulerSE) !== pending.previous)
        throw new Error(
          'La conexión de SchedulerSE ha cambiado. Se han conservado los ajustes guardados.',
        );
      pending.state = 'saving';
      const saved = await this.settings.update(current.revision, {
        ...current.value,
        schedulerSE: pending.config,
      });
      if (!saved) {
        pending.state = 'pending';
        throw new Error('Los ajustes han cambiado. Recarga y comprueba de nuevo la aprobación.');
      }
      pending.state = 'configured';
      return { saved: true };
    } catch (error) {
      pending.state =
        pending.state === 'saving'
          ? 'uncertain'
          : pending.state === 'checking'
            ? 'pending'
            : pending.state;
      throw error;
    }
  }
}
