import { authKeyRefs, connectionKeyRef } from "@freebirdai/dash-spec";
import type { SpecStore } from "./store.js";
import type { KeyStore } from "./vault.js";

/** Old catalog imports shared multipart secret names. Ambiguous ownership requires re-entry. */
export const migrateCredentialRefs = (store: SpecStore, keys: KeyStore): void => {
  const connections = store.listConnections();
  const owners = new Map<string, number>();
  for (const connection of connections)
    for (const ref of new Set(authKeyRefs(connection.auth)))
      owners.set(ref, (owners.get(ref) ?? 0) + 1);
  for (const connection of connections) {
    if (!connection.catalog || connection.auth.type !== "headers") continue;
    let changed = false;
    const parts = connection.auth.parts.map((part, index) => {
      const keyRef = connectionKeyRef(connection.id, index + 1);
      if (part.keyRef === keyRef) return part;
      changed = true;
      // Never guess which account a shared credential belongs to.
      const secret = owners.get(part.keyRef) === 1 ? keys.get(part.keyRef) : null;
      if (secret && !keys.has(keyRef)) keys.set(keyRef, secret);
      return { ...part, keyRef };
    });
    if (changed) {
      const auth = { ...connection.auth, parts };
      store.putConnection({
        ...connection,
        auth,
        ...(connection.dialect ? { dialect: { ...connection.dialect, auth } } : {}),
        credentialsRevision: (connection.credentialsRevision ?? 0) + 1,
      });
    }
  }
};
