import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectionSchema } from "@freebirdai/dash-spec";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";
import { migrateCredentialRefs } from "./credential-migration.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const fixture = (ids: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "dash-credential-migration-"));
  directories.push(root);
  const store = new SpecStore(join(root, "boards"), join(root, "connections"));
  const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(root, "keys.json"));
  for (const id of ids)
    store.putConnection(
      connectionSchema.parse({
        id,
        title: id,
        kind: "rest",
        catalog: "vendor",
        baseUrl: "https://example.com",
        auth: {
          type: "headers",
          parts: [
            { header: "X-Client", keyRef: "shared-client" },
            { header: "X-Secret", keyRef: "shared-secret" },
          ],
        },
        ops: [],
      }),
    );
  keys.set("shared-client", "client");
  keys.set("shared-secret", "secret");
  return { store, keys };
};
describe("legacy catalog credential ownership", () => {
  it("migrates an unambiguous owner once", () => {
    const { store, keys } = fixture(["one"]);
    migrateCredentialRefs(store, keys);
    expect(keys.get("one-key-1")).toBe("client");
    expect(keys.get("one-key-2")).toBe("secret");
    const migrated = store.getConnection("one");
    migrateCredentialRefs(store, keys);
    expect(store.getConnection("one")).toEqual(migrated);
  });
  it("requires re-entry when old names were shared by two accounts", () => {
    const { store, keys } = fixture(["one", "two"]);
    migrateCredentialRefs(store, keys);
    expect(keys.has("one-key-1")).toBe(false);
    expect(keys.has("two-key-1")).toBe(false);
    expect(store.getConnection("one")?.auth).not.toEqual(store.getConnection("two")?.auth);
    // Preserve the original encrypted entry; do not assign it to either account.
    expect(keys.has("shared-client")).toBe(true);
  });
});
