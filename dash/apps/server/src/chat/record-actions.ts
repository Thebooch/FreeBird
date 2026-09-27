import type { ActionContext, ActionDefinition, ActionPreflightResult } from "@freebirdai/core";
import type { Principal } from "@freebirdai/dash-spec";
import { principalSchema } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { WriteIntent, WriteReview } from "../writes/pending.js";
import type { CommitResult } from "../writes/service.js";
import { WriteError } from "../writes/service.js";

/**
 * The assistant asking to change a record — and never changing one.
 *
 * Two actions, built on the guide's action harness so the person's yes goes
 * through the same confirmation card every other action uses. The assistant
 * describes the change; the write service builds it and reads the record; a
 * person looks at the review and says yes; only then is anything sent. The
 * model has no way to reach the last step on its own: the handler commits a
 * review by its digest, and the only reviews that exist are ones the service
 * built.
 *
 * Why the preflight is careful about when it prepares. The harness runs it on
 * every step of a turn and again at the moment somebody clicks Apply, and at
 * that moment it merges whatever the preflight returns into the arguments it
 * then executes with. A preflight that prepared afresh there would swap the
 * reviewed change for an unreviewed one at the exact moment of consent. So
 * while the change is being proposed, the same request returns the review it
 * already has; and at confirmation, it prepares nothing — it only checks the
 * review being approved is still there, still unsent, still this person's,
 * and still the change that was asked for.
 */

export interface RecordChangeOps {
  prepare(principal: Principal, intent: WriteIntent, sessionId: string): Promise<WriteReview>;
  commit(principal: Principal, pendingId: string, digest: string): Promise<CommitResult>;
  /** The review of a pending change, when it is this principal's and unspent. */
  pending(principal: Principal, pendingId: string): { readonly review: WriteReview; readonly intentDigest: string } | undefined;
  intentDigest(intent: WriteIntent): string;
  /** Whether this principal may ask for this kind of change here at all. */
  allowed(principal: Principal, connection: string, entity: string, kind: WriteIntent["kind"]): Promise<boolean>;
  /** After a change lands: drop whatever the conversation remembers that it made stale. */
  changed?(result: CommitResult, sessionId: string): void;
}

const parentsSchema = z
  .array(z.object({ param: z.string().min(1), value: z.string().min(1) }))
  .optional()
  .describe("Ids of the record this one lives under, by parameter — e.g. a listing needs its unit's id.");

const valuesSchema = z
  .array(
    z.object({
      field: z.string().min(1).describe("A field the change accepts, as the user named it, or as can_change_record lists it."),
      value: z.string().describe("The new value, as text."),
      clear: z.boolean().optional().describe("True to empty the field instead of setting a value."),
    }),
  )
  .optional()
  .describe(
    "The COMPLETE list of values to set. When adding one, send every value again — the list replaces the last one.",
  );

const systemSet = (what: string) =>
  z.string().optional().describe(`Set by the system: the ${what}. Never fill this in.`);

export const changeRecordSchema = z.object({
  connection: z.string().min(1).describe("Id of a connection from the CONNECTIONS list."),
  entity: z.string().min(1).describe("The record type, as can_change_record names it."),
  kind: z
    .enum(["create", "update", "action"])
    .describe("create a new record, update one, or run one of its actions."),
  actionId: z.string().optional().describe("For kind \"action\": which action, as can_change_record lists it."),
  id: z
    .string()
    .optional()
    .describe("The record's own id. Leave out to create one, or for a record that exists once under its parent."),
  parents: parentsSchema,
  values: valuesSchema,
  pendingWriteId: systemSet("review being approved"),
  digest: systemSet("fingerprint of what was reviewed"),
});

export const removeRecordSchema = z.object({
  connection: z.string().min(1).describe("Id of a connection from the CONNECTIONS list."),
  entity: z.string().min(1).describe("The record type, as can_change_record names it."),
  kind: z.enum(["delete", "action"]).describe("delete the record, or run an action that cannot be undone."),
  actionId: z.string().optional().describe("For kind \"action\": which action, as can_change_record lists it."),
  id: z.string().optional().describe("The record's own id. Leave out for a record that exists once under its parent."),
  parents: parentsSchema,
  pendingWriteId: systemSet("review being approved"),
  digest: systemSet("fingerprint of what was reviewed"),
});

type ChangeArgs = z.infer<typeof changeRecordSchema>;
type RemoveArgs = z.infer<typeof removeRecordSchema>;
type RecordArgs = ChangeArgs | RemoveArgs;

const principalOf = (ctx: ActionContext<unknown>): Principal | null => {
  const extra = (ctx.auth as { extra?: Record<string, unknown> } | null)?.extra;
  const parsed = principalSchema.safeParse(extra?.["principal"]);
  return parsed.success ? parsed.data : null;
};

const viaOf = (ctx: ActionContext<unknown>): string | undefined =>
  (ctx.auth as { extra?: Record<string, unknown> } | null)?.extra?.["via"] as string | undefined;

/** The change the assistant is asking for, in the write service's terms. */
export const intentFromArgs = (args: RecordArgs): WriteIntent => {
  const values: Record<string, unknown> = {};
  for (const entry of "values" in args ? (args.values ?? []) : []) {
    values[entry.field] = entry.clear ? null : entry.value;
  }
  const parents = Object.fromEntries((args.parents ?? []).map((part) => [part.param, part.value]));
  return {
    connection: args.connection,
    entity: args.entity,
    kind: args.kind,
    ...(args.kind === "action" && args.actionId ? { action: args.actionId } : {}),
    ...(args.id ? { id: args.id } : {}),
    ...(Object.keys(parents).length > 0 ? { parents } : {}),
    ...(Object.keys(values).length > 0 ? { values } : {}),
  };
};

const blocked = (message: string, code = "change_unavailable"): ActionPreflightResult => ({
  ok: false,
  message,
  // `field` keeps `update_action_args` on offer, so the model can fix the values rather than only cancel.
  blockers: [{ code, field: "values", message }],
});

/** The cards's rows: what each field was and will be. */
const previewRows = (review: WriteReview | undefined) =>
  review
    ? review.rows
        .filter((row) => row.changed)
        .slice(0, 20)
        .map((row) => ({ label: row.label, value: `${row.before ?? "—"} → ${row.after ?? "—"}` }))
    : [];

const build = <TArgs extends RecordArgs>(
  ops: RecordChangeOps,
  definition: {
    readonly id: string;
    readonly description: string;
    readonly schema: z.ZodType<TArgs>;
    readonly requiresConfirmation: "preview" | "strict";
  },
): ActionDefinition<TArgs, unknown, unknown> => ({
  id: definition.id,
  description: definition.description,
  schema: definition.schema,
  requiresConfirmation: definition.requiresConfirmation,
  // A change to somebody's account is never exposed to an outside agent through MCP.
  mcp: { expose: false },

  authorize: async (args, ctx) => {
    const principal = principalOf(ctx);
    if (!principal) return { ok: false as const, reason: "Nobody is signed in.", status: 401 };
    const allowed = await ops.allowed(principal, args.connection, args.entity, args.kind);
    return (
      allowed || {
        ok: false as const,
        reason: `You are not permitted to change "${args.entity}" records on this connection.`,
        status: 403,
      }
    );
  },

  preflight: async (args, ctx) => {
    const principal = principalOf(ctx);
    if (!principal) return blocked("Nobody is signed in.");
    const intent = intentFromArgs(args);

    // At the moment of consent: check what is being approved; never prepare anything new.
    if (viaOf(ctx) === "confirm") {
      const pending = args.pendingWriteId ? ops.pending(principal, args.pendingWriteId) : undefined;
      if (!pending || pending.review.digest !== args.digest || pending.intentDigest !== ops.intentDigest(intent)) {
        return blocked("This review has expired or changed since it was shown. Ask for the change again.", "review_expired");
      }
      return { ok: true };
    }

    try {
      const review = await ops.prepare(principal, intent, ctx.sessionId);
      // Already carrying this review: nothing new to merge, so nothing re-emitted.
      if (args.pendingWriteId === review.pendingId && args.digest === review.digest) return { ok: true };
      return { ok: true, resolvedArgs: { pendingWriteId: review.pendingId, digest: review.digest } };
    } catch (error) {
      if (error instanceof WriteError) {
        return blocked(error.message, error.code === "invalid" ? "missing_values" : error.code);
      }
      return blocked("The change could not be prepared.");
    }
  },

  preview: (args) => {
    const review = args.pendingWriteId ? reviews.get(args.pendingWriteId) : undefined;
    return review
      ? { title: review.title, summary: review.summary, rows: previewRows(review) }
      : { title: "Preparing the change…", summary: "Reading the record as it is now.", rows: [] };
  },

  handler: async (args, ctx) => {
    const principal = principalOf(ctx);
    if (!principal) throw new Error("Nobody is signed in.");
    if (!args.pendingWriteId || !args.digest) {
      throw new Error("There is no reviewed change to send. Ask for the change again.");
    }
    try {
      const result = await ops.commit(principal, args.pendingWriteId, args.digest);
      ops.changed?.(result, ctx.sessionId);
      // Small on purpose: the chat keeps this, and a whole record does not belong in a transcript.
      return {
        status: result.status,
        title: result.title,
        kind: result.kind,
        connection: result.connection,
        entity: result.entity,
        ...(result.key ? { key: result.key } : {}),
        changed: result.changed,
        invalidated: result.invalidated,
      };
    } catch (error) {
      if (error instanceof WriteError && error.code === "stale") {
        throw new Error(`${error.message} Ask for the change again to see it as it is now.`);
      }
      throw error instanceof WriteError ? new Error(error.message) : error;
    }
  },
});

/** Reviews by pending id, so the harness's synchronous preview can show one. */
const reviews = new Map<string, WriteReview>();

export const recordChangeActions = (ops: RecordChangeOps): ActionDefinition<RecordArgs, unknown, unknown>[] => {
  // The card's preview is synchronous, so each review is kept where it can reach it.
  const remembering: RecordChangeOps = {
    ...ops,
    prepare: async (principal, intent, sessionId) => {
      const review = await ops.prepare(principal, intent, sessionId);
      reviews.set(review.pendingId, review);
      if (reviews.size > 200) reviews.delete(reviews.keys().next().value!);
      return review;
    },
  };
  return [
    build(remembering, {
      id: "change_record",
      description:
        "Propose creating a record, changing one, or running one of its actions, on a connected account. " +
        "Call it directly when the user asks for a change — name fields as they did; a refusal lists the " +
        "fields it takes. The person is shown " +
        "exactly what will change and must approve it; nothing is sent until they do.",
      schema: changeRecordSchema,
      requiresConfirmation: "preview",
    }) as ActionDefinition<RecordArgs, unknown, unknown>,
    build(remembering, {
      id: "remove_record",
      description:
        "Propose deleting a record, or running an action that cannot be undone (such as inactivating it), " +
        "on a connected account. The person must approve it; nothing is sent until they do.",
      schema: removeRecordSchema,
      requiresConfirmation: "strict",
    }) as ActionDefinition<RecordArgs, unknown, unknown>,
  ];
};
