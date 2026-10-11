import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogEntrySchema, entityGraph, type CatalogEntry } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";

/** The shipped mail entries: hand-checked, so they must parse whole and offer what Comms sends with. */

const here = dirname(fileURLToPath(import.meta.url));
const entry = (id: string): CatalogEntry => catalogEntrySchema.parse(JSON.parse(readFileSync(join(here, "..", "..", "..", "..", "catalog", `${id}.json`), "utf8")));

describe("the shipped mail catalog entries", () => {
  it.each(["gmail", "outlook"])("%s parses with its sign-in, reads and writes", (id) => {
    const one = entry(id);
    expect(one.dialect.auth?.type).toBe("oauth2");
    expect(one.ops.map((op) => op.id)).toEqual(expect.arrayContaining(["profile", "messages", "message"]));
    expect(one.writes.map((write) => write.id)).toEqual(["send", "create-draft"]);
    const graph = entityGraph({ entities: one.entities, resources: one.resources, ops: one.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })), writes: one.writes });
    const send = graph.writesOf("message").actions.find((action) => action.action?.id === "send");
    expect(send?.mime).toBeDefined();
    expect(send?.own).toBeUndefined();
    const draft = graph.writesOf(id === "gmail" ? "draft" : "message").create;
    expect(draft?.op).toBe("create-draft");
    expect(draft?.mime).toBeDefined();
  });

  it("asks Google for a refresh token", () => {
    const auth = entry("gmail").dialect.auth;
    expect(auth?.type === "oauth2" ? auth.authorizeParams : undefined).toMatchObject({ access_type: "offline", prompt: "consent" });
  });
});
