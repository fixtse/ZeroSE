import { adminPath } from './admin-path';
import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';

export const authClient = createAuthClient({
  basePath: adminPath('/api/auth'),
  plugins: [twoFactorClient(), passkeyClient()],
  fetchOptions: { headers: { 'X-Admin-Request': '1' } },
});

export function authResult<T extends { error?: { message?: string } | null }>(result: T): T {
  if (result.error) throw new Error(result.error.message || 'No se pudo confirmar la operación.');
  return result;
}
