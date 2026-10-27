import { createHash, randomBytes } from 'node:crypto';
import type { AccessProfile, BotId } from '../domain/access.js';
import type { Config, GoogleCredential } from '../domain/config.js';

export const googleScopes = {
  calendar: 'https://www.googleapis.com/auth/calendar',
  tasks: 'https://www.googleapis.com/auth/tasks',
  documents: 'https://www.googleapis.com/auth/documents',
  drive: 'https://www.googleapis.com/auth/drive',
} as const;
export function requiredGoogleScopes(profile: AccessProfile, ownerTaskProvider = 'google') {
  const scopes: string[] = [];
  if (profile.capabilities.includes('calendar')) scopes.push(googleScopes.calendar);
  const taskProvider =
    profile.homeAssistant?.taskProvider || (profile.owner ? ownerTaskProvider : 'google');
  if (profile.capabilities.includes('tasks') && taskProvider !== 'home_assistant')
    scopes.push(googleScopes.tasks);
  if (profile.capabilities.includes('documents'))
    scopes.push(googleScopes.documents, googleScopes.drive);
  return scopes;
}

export class GoogleConnectionError extends Error {}

export class GoogleOAuthAttemptError extends GoogleConnectionError {
  constructor(
    readonly reason: 'browser_missing' | 'state_missing' | 'browser_mismatch' | 'expired',
  ) {
    const messages = {
      browser_missing:
        'No se recibió la cookie de autorización. Permite las cookies y conecta Google desde la dirección pública de Zero en el mismo navegador.',
      state_missing:
        'Esta autorización ya se utilizó o se perdió al reiniciar Zero. Inicia una nueva desde el perfil.',
      browser_mismatch:
        'La autorización se inició en otro navegador. Vuelve al navegador donde conectaste Google.',
      expired: 'La autorización superó los diez minutos. Inicia una nueva desde el perfil.',
    };
    super(messages[reason]);
  }
}

export interface GoogleOAuthPort {
  authorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    challenge: string;
    scopes: string[];
  }): string;
  exchange(input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    verifier: string;
    code: string;
  }): Promise<string>;
  verify(google: Config['google'], scopes: string[]): Promise<void>;
}
export interface GoogleConnectionRepository {
  profile(bot: BotId, chatId: string): Promise<AccessProfile | undefined>;
  replaceGoogleConnection(
    bot: BotId,
    chatId: string,
    expected: Config['google'] | undefined,
    google: Config['google'],
    scopes: string[],
    ownerTaskProvider: string,
  ): Promise<boolean>;
}
interface Pending {
  bot: BotId;
  chatId: string;
  browser: string;
  scopes: string[];
  expires: number;
  verifier: string;
  client: Pick<GoogleCredential, 'clientId' | 'clientSecret'>;
  expected: Config['google'] | undefined;
  google: Config['google'];
}

/** Short-lived, single-use authorization attempts. A restart requires starting again. */
export class GoogleConnection {
  private pending = new Map<string, Pending>();
  constructor(
    private repository: GoogleConnectionRepository,
    private oauth: GoogleOAuthPort,
    readonly redirectUri: string,
    private ownerGoogle: Config['google'],
    private ownerTaskProvider = 'google',
    private now: () => number = Date.now,
  ) {}
  async details(bot: BotId, chatId: string) {
    const profile = await this.repository.profile(bot, chatId);
    if (!profile) throw new GoogleConnectionError('Guarda el perfil antes de conectar Google.');
    return {
      redirectUri: this.redirectUri,
      scopes: requiredGoogleScopes(profile, this.ownerTaskProvider),
    };
  }
  async begin(bot: BotId, chatId: string, browser: string, clientId = '', clientSecret = '') {
    for (const [state, attempt] of this.pending)
      if (attempt.expires <= this.now()) this.pending.delete(state);
    if (this.pending.size >= 100)
      throw new GoogleConnectionError('Hay demasiadas autorizaciones pendientes.');
    const profile = await this.repository.profile(bot, chatId);
    if (!profile) throw new GoogleConnectionError('Guarda el perfil antes de conectar Google.');
    const scopes = requiredGoogleScopes(profile, this.ownerTaskProvider);
    if (!scopes.length)
      throw new GoogleConnectionError('Activa y guarda al menos una herramienta que use Google.');
    const google =
      profile.google ||
      (profile.owner
        ? this.ownerGoogle
        : {
            clientId: '',
            clientSecret: '',
            refreshToken: '',
            credentials: {},
            calendarId: 'primary',
            taskListId: '@default',
            contextDocumentId: '',
            documentFolderId: '',
          });
    // Existing installations can migrate without exposing or copying their saved secret.
    const legacy = Object.values(google.credentials || {}).find((value) => value?.clientId);
    const saved = google.clientId ? google : legacy;
    const resolvedId = clientId || saved?.clientId || '';
    const resolvedSecret =
      clientSecret || (resolvedId === saved?.clientId ? saved.clientSecret : '');
    if (!resolvedId || !resolvedSecret)
      throw new GoogleConnectionError('Introduce el client ID y su client secret.');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.pending.set(state, {
      bot,
      chatId,
      browser,
      scopes,
      expires: this.now() + 10 * 60_000,
      verifier,
      client: { clientId: resolvedId, clientSecret: resolvedSecret },
      expected: structuredClone(profile.google),
      google: structuredClone(google),
    });
    return this.oauth.authorizationUrl({
      clientId: resolvedId,
      redirectUri: this.redirectUri,
      state,
      scopes,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
  }
  private attempt(state: string, browser: string) {
    if (!browser) throw new GoogleOAuthAttemptError('browser_missing');
    const attempt = this.pending.get(state);
    if (!attempt) throw new GoogleOAuthAttemptError('state_missing');
    if (attempt.expires <= this.now()) throw new GoogleOAuthAttemptError('expired');
    if (attempt.browser !== browser) throw new GoogleOAuthAttemptError('browser_mismatch');
    return attempt;
  }
  check(state: string, browser: string, bot: BotId, chatId: string) {
    const attempt = this.attempt(state, browser);
    if (attempt.bot !== bot || attempt.chatId !== chatId)
      throw new GoogleOAuthAttemptError('state_missing');
  }
  async complete(state: string, browser: string, code: string, denied: boolean) {
    const attempt = this.attempt(state, browser);
    this.pending.delete(state); // Never retry an uncertain code exchange.
    const target = { bot: attempt.bot, chatId: attempt.chatId };
    if (denied) return { ...target, status: 'cancelled' as const };
    if (!code) return { ...target, status: 'failed' as const };
    try {
      const refreshToken = await this.oauth.exchange({
        ...attempt.client,
        redirectUri: this.redirectUri,
        verifier: attempt.verifier,
        code,
      });
      const google = { ...attempt.google, ...attempt.client, refreshToken, credentials: {} };
      await this.oauth.verify(google, attempt.scopes);
      const current = await this.repository.profile(attempt.bot, attempt.chatId);
      if (
        !current ||
        JSON.stringify(requiredGoogleScopes(current, this.ownerTaskProvider)) !==
          JSON.stringify(attempt.scopes)
      )
        return { ...target, status: 'changed' as const };
      const saved = await this.repository.replaceGoogleConnection(
        attempt.bot,
        attempt.chatId,
        attempt.expected,
        google,
        attempt.scopes,
        this.ownerTaskProvider,
      );
      return { ...target, status: saved ? ('connected' as const) : ('changed' as const) };
    } catch {
      // Provider responses and credentials must never reach the browser or logs.
      return { ...target, status: 'failed' as const };
    }
  }
}
