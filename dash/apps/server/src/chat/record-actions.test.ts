import type { ActionContext } from "@freebirdai/core";
import { describe, expect, it } from "vitest";
import { toJsonSchema } from "../llm.js";
import { WriteError } from "@freebirdai/connect/host";
import type { WriteReview } from "@freebirdai/connect/host";
import {
  changeRecordSchema,
  intentFromArgs,
  recordChangeActions,
  removeRecordSchema,
  type RecordChangeOps,
} from "./record-actions.js";

/**
 * The assistant proposing a change, and the one moment it must not be able
 * to: the click that approves it.
 */

const OWNER = { userId: "local", workspaceId: "local", role: "owner", kind: "local-owner" } as const;

const ctx = (via: "chat" | "confirm" = "chat"): ActionContext<unknown> => ({
  auth: { userId: "local", extra: { principal: OWNER, via } },
  sessionId: "session-1",
});

const review = (id = "p1", digest = "d1"): WriteReview => ({
  pendingId: id,
  digest,
  connection: "rentals",
  connectionTitle: "Rentals",
  entity: "rental",
  entityName: "Property",
  kind: "update",
  mode: "replace",
  title: "Update a property",
  summary: "Change 1 value on property “Maple Court” on Rentals.",
  record: "Maple Court",
  rows: [{ field: "Name", label: "Name", before: "Maple Court", after: "Maple Court East", changed: true }],
  warnings: [],
  danger: false,
  unverified: false,
  inferred: false,
  expiresAt: new Date(0).toISOString(),
});

const fakeOps = (overrides: Partial<RecordChangeOps> = {}) => {
  const calls = { prepare: 0, commit: 0, changed: 0 };
  const held = new Map<string, { review: WriteReview; intentDigest: string }>();
  const ops: RecordChangeOps = {
    prepare: async (_principal, intent) => {
      calls.prepare++;
      const made = review();
      held.set(made.pendingId, { review: made, intentDigest: JSON.stringify(intent) });
      return made;
    },
    commit: async (_principal, pendingId, digest) => {
      calls.commit++;
      return {
        status: "succeeded",
        connection: "rentals",
        entity: "rental",
        kind: "update",
        key: { id: "42" },
        record: { Id: 42, Name: "a whole record that must not reach the transcript" },
        changed: ["Name"],
        invalidated: { connection: "rentals", ops: ["rental"] },
        title: `${pendingId}:${digest}`,
      };
    },
    pending: (_principal, pendingId) => held.get(pendingId),
    intentDigest: (intent) => JSON.stringify(intent),
    allowed: async () => true,
    changed: () => {
      calls.changed++;
    },
    ...overrides,
  };
  return { ops, calls, held };
};

const ARGS = {
  connection: "rentals",
  entity: "rental",
  kind: "update" as const,
  id: "42",
  values: [{ field: "Name", value: "Maple Court East" }],
};

describe("record change actions", () => {
  it("keeps both schemas flat enough for every model adapter", () => {
    expect(() => toJsonSchema(changeRecordSchema)).not.toThrow();
    expect(() => toJsonSchema(removeRecordSchema)).not.toThrow();
    // The harness offers each action as a partial schema on idle turns.
    expect(() => toJsonSchema(changeRecordSchema.partial())).not.toThrow();
    expect(Object.keys(changeRecordSchema.shape)).not.toContain("label");
    expect(Object.keys(changeRecordSchema.shape)).not.toContain("args");
  });

  it("asks before a change and asks harder before a removal, and is never offered to an outside agent", () => {
    const [change, remove] = recordChangeActions(fakeOps().ops);
    expect(change).toMatchObject({ id: "change_record", requiresConfirmation: "preview", mcp: { expose: false } });
    expect(remove).toMatchObject({ id: "remove_record", requiresConfirmation: "strict", mcp: { expose: false } });
  });

  it("reads the values the model sent into the service's terms", () => {
    expect(
      intentFromArgs({
        ...ARGS,
        parents: [{ param: "unitId", value: "5" }],
        values: [
          { field: "Name", value: "A" },
          { field: "YearBuilt", value: "", clear: true },
        ],
      }),
    ).toEqual({
      connection: "rentals",
      entity: "rental",
      kind: "update",
      id: "42",
      parents: { unitId: "5" },
      values: { Name: "A", YearBuilt: null },
    });
  });

  it("prepares while proposing, and hands the review's id back to the harness once", async () => {
    const { ops, calls } = fakeOps();
    const [change] = recordChangeActions(ops);
    const first = await change!.preflight!(ARGS, ctx());
    expect(first).toEqual({ ok: true, resolvedArgs: { pendingWriteId: "p1", digest: "d1" } });
    // Carrying the same review already: nothing new to merge.
    const again = await change!.preflight!({ ...ARGS, pendingWriteId: "p1", digest: "d1" }, ctx());
    expect(again).toEqual({ ok: true });
    expect(calls.prepare).toBe(2);
  });

  it("never prepares at the moment of approval, and refuses a review that is gone or different", async () => {
    const { ops, calls } = fakeOps();
    const [change] = recordChangeActions(ops);
    await change!.preflight!(ARGS, ctx());
    expect(calls.prepare).toBe(1);

    const approved = await change!.preflight!({ ...ARGS, pendingWriteId: "p1", digest: "d1" }, ctx("confirm"));
    expect(approved).toEqual({ ok: true });

    const swapped = await change!.preflight!(
      { ...ARGS, values: [{ field: "Name", value: "Something else" }], pendingWriteId: "p1", digest: "d1" },
      ctx("confirm"),
    );
    expect(swapped).toMatchObject({ ok: false, blockers: [{ code: "review_expired" }] });

    const missing = await change!.preflight!(ARGS, ctx("confirm"));
    expect(missing).toMatchObject({ ok: false });
    expect(calls.prepare).toBe(1);
  });

  it("keeps the values open for correction when some are missing", async () => {
    const { ops } = fakeOps({
      prepare: async () => {
        throw new WriteError(422, "invalid", "Some of the values cannot be sent: Postal code is required.");
      },
    });
    const [change] = recordChangeActions(ops);
    const result = await change!.preflight!(ARGS, ctx());
    expect(result).toMatchObject({
      ok: false,
      blockers: [{ code: "missing_values", field: "values", message: expect.stringContaining("Postal code") }],
    });
    expect((result as unknown as { blockers: Array<Record<string, unknown>> }).blockers[0]).not.toHaveProperty("suggestActions");
  });

  it("commits only a reviewed change, and keeps the transcript small", async () => {
    const { ops, calls } = fakeOps();
    const [change] = recordChangeActions(ops);
    await expect(change!.handler(ARGS, ctx("confirm"))).rejects.toThrow(/no reviewed change/);
    const result = (await change!.handler({ ...ARGS, pendingWriteId: "p1", digest: "d1" }, ctx("confirm"))) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "succeeded", key: { id: "42" }, changed: ["Name"] });
    expect(result).not.toHaveProperty("record");
    expect(calls.commit).toBe(1);
    expect(calls.changed).toBe(1);
  });

  it("shows the review's own rows on the card once it exists", async () => {
    const { ops } = fakeOps();
    const [change] = recordChangeActions(ops);
    expect(change!.preview!(ARGS, {})).toMatchObject({ title: "Preparing the change…" });
    await change!.preflight!(ARGS, ctx());
    expect(change!.preview!({ ...ARGS, pendingWriteId: "p1" }, {})).toEqual({
      title: "Update a property",
      summary: "Change 1 value on property “Maple Court” on Rentals.",
      rows: [{ label: "Name", value: "Maple Court → Maple Court East" }],
    });
  });

  it("is refused before anything else when the change is not allowed", async () => {
    const { ops } = fakeOps({ allowed: async () => false });
    const [change] = recordChangeActions(ops);
    const decision = await change!.authorize!(ARGS, ctx());
    expect(decision).toMatchObject({ ok: false, status: 403 });
  });
});
