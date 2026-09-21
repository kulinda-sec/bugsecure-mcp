import type { CredentialStore, StoredCredentials } from '../../src/auth/stdio/credential-store.js';

export const memoryStore = (initial: StoredCredentials[] = []): CredentialStore & { saves: number } => {
  const map = new Map(initial.map((c) => [c.issuer, c]));
  const store = {
    kind: 'file' as const,
    location: 'memory',
    saves: 0,
    load: (issuer: string) => Promise.resolve(map.get(issuer)),
    save: (c: StoredCredentials) => {
      store.saves += 1;
      map.set(c.issuer, c);
      return Promise.resolve();
    },
    delete: (issuer: string) => Promise.resolve(map.delete(issuer)),
  };
  return store;
};
