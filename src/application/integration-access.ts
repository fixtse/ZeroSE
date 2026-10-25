import {
  integrationScopes,
  type IntegrationCredential,
  type IntegrationScope,
} from '../domain/integration-access.js';

export interface IntegrationCredentialRepository {
  insert(value: IntegrationCredential, digest: string): Promise<void>;
  list(offset: number, limit: number): Promise<{ items: IntegrationCredential[]; total: number }>;
  revoke(id: string, at: string): Promise<void>;
  find(digest: string): Promise<IntegrationCredential | undefined>;
}
export interface CredentialCrypto {
  id(): string;
  secret(): string;
  digest(value: string): string;
}
/** Only digests cross the persistence port; the secret is returned once at issuance. */
export class IntegrationAccess {
  constructor(
    private repository: IntegrationCredentialRepository,
    private crypto: CredentialCrypto,
    private now = () => new Date(),
  ) {}
  list(offset: number, limit: number) {
    return this.repository.list(offset, limit);
  }
  async issue(name: string, days: number) {
    if (!name.trim() || name.length > 100 || !Number.isInteger(days) || days < 1 || days > 3650)
      throw new Error('Invalid credential');
    const now = this.now();
    const token = 'zero_ha_' + this.crypto.secret();
    const credential: IntegrationCredential = {
      id: this.crypto.id(),
      name: name.trim(),
      scopes: [...integrationScopes],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + days * 86400000).toISOString(),
      revokedAt: null,
    };
    await this.repository.insert(credential, this.crypto.digest(token));
    return { ...credential, token };
  }
  revoke(id: string) {
    return this.repository.revoke(id, this.now().toISOString());
  }
  async authorize(header: string | string[] | undefined, scope: IntegrationScope) {
    if (typeof header !== 'string' || !/^Bearer zero_ha_[a-f0-9]{64}$/.test(header)) return false;
    const credential = await this.repository.find(this.crypto.digest(header.slice(7)));
    return (
      !!credential &&
      !credential.revokedAt &&
      new Date(credential.expiresAt) > this.now() &&
      credential.scopes.includes(scope)
    );
  }
}
