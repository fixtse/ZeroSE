import { googleScopes, type GoogleOAuthPort } from '../../application/google-connection.js';
import type { Config } from '../../domain/config.js';

export class GoogleOAuth implements GoogleOAuthPort {
  authorizationUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    challenge: string;
    scopes: string[];
  }) {
    return (
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        state: input.state,
        code_challenge: input.challenge,
        code_challenge_method: 'S256',
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent select_account',
        scope: input.scopes.join(' '),
      })
    );
  }
  private async token(body: Record<string, string>) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Google authorization failed');
    return await response.json();
  }
  async exchange(input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    verifier: string;
    code: string;
  }) {
    const result = await this.token({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      code: input.code,
      grant_type: 'authorization_code',
    });
    if (typeof result.refresh_token !== 'string' || !result.refresh_token)
      throw new Error('Google did not grant offline access');
    return result.refresh_token;
  }
  async verify(google: Config['google'], requiredScopes: string[]) {
    // Test the persisted credential, rather than relying on the initial access token.
    const token = await this.token({
      client_id: google.clientId,
      client_secret: google.clientSecret,
      refresh_token: google.refreshToken,
      grant_type: 'refresh_token',
    });
    const scopes = new Set(String(token.scope || '').split(' '));
    if (!token.access_token || requiredScopes.some((scope) => !scopes.has(scope)))
      throw new Error('Google did not grant all required permissions');
    const read = async (url: string, allowMissing = false) => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (allowMissing && response.status === 404) return {};
      if (!response.ok) throw new Error('Google connection verification failed');
      return await response.json();
    };
    if (requiredScopes.includes(googleScopes.calendar))
      await read('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1');
    if (requiredScopes.includes(googleScopes.tasks))
      await read('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1');
    if (!requiredScopes.includes(googleScopes.documents)) return;
    const files = await read(
      'https://www.googleapis.com/drive/v3/files?' +
        new URLSearchParams({
          pageSize: '1',
          q: "mimeType = 'application/vnd.google-apps.document' and trashed = false",
          fields: 'files(id)',
        }),
    );
    const documentId = google.contextDocumentId || files.files?.[0]?.id;
    await read(
      'https://docs.googleapis.com/v1/documents/' +
        encodeURIComponent(documentId || 'zero-oauth-verification-no-document'),
      !documentId,
    );
    if (google.documentFolderId)
      await read(
        'https://www.googleapis.com/drive/v3/files/' +
          encodeURIComponent(google.documentFolderId) +
          '?fields=id',
      );
  }
}
