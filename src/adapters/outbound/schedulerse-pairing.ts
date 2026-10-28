import { z } from 'zod';
import type { SchedulerPairingPort } from '../../application/schedulerse-pairing.js';
import { SchedulerSE } from './schedulerse.js';
import { boundedBody, jsonBody } from './http.js';
import { schedulerFetch, schedulerHttpAddress } from './schedulerse-http.js';

/** No redirects, retries or remote error-body forwarding: credentials must never
 * follow a redirect or appear in an admin error response. */
export class SchedulerSEPairingClient implements SchedulerPairingPort {
  async validateUrl(value: string) {
    const url = new URL(value);
    if (url.protocol === 'http:') await schedulerHttpAddress(url);
  }
  private async request(url: string, options: RequestInit) {
    const response = await schedulerFetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `SchedulerSE devolvió HTTP ${response.status}. Comprueba la URL, la versión y el estado de la solicitud.`,
      );
    }
    return JSON.parse((await boundedBody(response, 4096)).toString('utf8'));
  }
  async begin(url: string, input: Parameters<SchedulerPairingPort['begin']>[1]) {
    const value = await this.request(url + '/api/pairing/v1/requests', {
      method: 'POST',
      ...jsonBody({
        id: input.id,
        secret_hash: input.secretHash,
        token_hash: input.tokenHash,
        callback_url: input.callbackUrl,
        callback_authorization: input.callbackAuthorization,
      }),
    });
    if (value.id !== input.id || value.state !== 'pending')
      throw new Error(
        'Respuesta de emparejamiento no válida. Consulta el estado antes de continuar.',
      );
  }
  async status(url: string, id: string, secret: string) {
    const value = await this.request(url + '/api/pairing/v1/requests/' + encodeURIComponent(id), {
      headers: { Authorization: 'Bearer ' + secret },
    });
    if (value.id !== id) throw new Error('La respuesta no corresponde a esta solicitud.');
    return z.enum(['pending', 'approved', 'revoked', 'expired']).parse(value.state);
  }
  async ready(config: Parameters<SchedulerPairingPort['ready']>[0]) {
    await new SchedulerSE(
      { ...config, callbackUrl: config.callbackUrl! },
      async () => undefined,
    ).ready();
  }
}
