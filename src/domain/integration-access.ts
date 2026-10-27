/** Credentials are restricted to HA client endpoints, never administration or chat. */
export const integrationScopes = ['voice', 'settings', 'rules'] as const;
export type IntegrationScope = (typeof integrationScopes)[number];
export interface IntegrationCredential {
  id: string;
  name: string;
  scopes: IntegrationScope[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
