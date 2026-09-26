import type { LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import type { ToolBinding, ToolResult } from "./types.js";

/**
 * Changing a record — what can be done, and how to ask for it.
 *
 * The fourth verb, and still one that never changes anything itself. It
 * exists so the assistant can answer "can you update this?" with the truth,
 * and now the truth has three shapes:
 *
 * - **Yes, with approval.** The connection has an endpoint for it. The
 *   answer lists the values the change takes, and says to propose it through
 *   `change_record` or `remove_record` — which builds a review the person
 *   has to approve. This tool never sends.
 * - **Not allowed.** The API can do it, but whoever is asking may not — a
 *   managed workspace's permissions. The open-source build never says this.
 * - **Not offered.** The API describes no endpoint that does it, or its
 *   write endpoints have not been read yet. That is a fact about the
 *   connection, and must not be dressed up as a policy.
 */

/** Why a change cannot be proposed. One reason, in the connection's own terms. */
export type WriteRefusal =
  /** The connection describes no endpoint that does this. */
  | "not-offered"
  /** The API can, but whoever is asking is not permitted to. */
  | "not-allowed"
  /** The resource is not one this workspace knows how to address. */
  | "unknown-resource";

/** One change the connection offers, as the model needs to ask for it. */
export interface OfferedChange {
  readonly kind: "create" | "update" | "delete" | "action";
  readonly title: string;
  /** For an action: the id to pass as `actionId`. */
  readonly actionId?: string;
  /** Cannot be undone through this API: ask with `remove_record`. */
  readonly danger?: boolean;
  readonly fields: ReadonlyArray<{
    readonly field: string;
    readonly label: string;
    readonly type: string;
    readonly required: boolean;
    readonly options?: readonly string[];
    readonly references?: string;
  }>;
}

/** What the connection can do to one record type, looked up by the server. */
export interface WriteOffer {
  readonly connection: string;
  readonly entity: string;
  readonly entityName: string;
  /** Whether whoever is asking may propose any of it. */
  readonly allowed: boolean;
  /** Ids the record's address needs besides its own — its parent's, by parameter. */
  readonly parents: readonly string[];
  /** True when the record is addressed by its parent alone (one per parent, like a listing). */
  readonly singleton: boolean;
  readonly changes: readonly OfferedChange[];
}

export interface WritePlan extends ToolResult {
  /** Always false: this tool describes, `change_record` proposes, and a person approves. */
  readonly performed: false;
  readonly refusal?: WriteRefusal;
  /** What would change, named, so the reply is specific. */
  readonly target?: {
    readonly resource: string;
    readonly connection: string;
    readonly id: string;
    readonly fields: readonly string[];
  };
  /** How to ask for it, when it can be asked for. */
  readonly offered?: WriteOffer;
  /** The proposal to make next, ready to make, when the request was specific enough. */
  readonly next?: { readonly tool: "change_record"; readonly args: Readonly<Record<string, unknown>> };
}

export interface WriteInput {
  readonly binding: ToolBinding | null;
  readonly resource: string;
  readonly id: string;
  readonly changes: ReadonlyArray<{ readonly field: string; readonly value: string }>;
  /** What the connection offers for this record type, when the server found anything. */
  readonly offer?: WriteOffer | undefined;
}

/**
 * Describe the change, and say whether and how it can be proposed.
 *
 * Shaped like the other verbs — same result type, same honesty about what was
 * and was not done — and it still sends nothing: `requests` is always zero.
 */
export const planWrite = (input: WriteInput): WritePlan => {
  const { note, next, ...rest } = describeWrite(input);
  // Whatever the answer, it leads with what the model must read: see the end of `describeWrite`.
  return { note, ...(next ? { next } : {}), ...rest };
};

const describeWrite = (input: WriteInput): WritePlan => {
  const fields = input.changes.map((change) => change.field);

  if (!input.binding) {
    return {
      performed: false,
      refusal: "unknown-resource",
      records: [],
      requests: 0,
      warnings: [],
      note:
        `"${input.resource}" is not a kind of record this workspace can address, so there ` +
        "is nothing to change and nothing to describe.",
    };
  }

  const named = fields.length > 0 ? fields.join(", ") : "no fields were named";
  const target = {
    resource: input.binding.resource,
    connection: input.binding.connectionTitle,
    id: input.id,
    fields,
  };
  const where = `${input.binding.resource} ${input.id} on ${input.binding.connectionTitle}`;
  const offer = input.offer;

  if (!offer || offer.changes.length === 0) {
    return {
      performed: false,
      refusal: "not-offered",
      records: [],
      requests: 0,
      warnings: [],
      target,
      note:
        `This would change ${where} (${named}). Nothing was sent. ${input.binding.connectionTitle} ` +
        "describes no endpoint that changes these records — or its write endpoints have not been read " +
        "yet, which the owner can do under Connections → Changes → Read write endpoints. This is about " +
        "what the connection describes, NOT a permission: the API may well allow it through its own interface.",
    };
  }

  if (!offer.allowed) {
    return {
      performed: false,
      refusal: "not-allowed",
      records: [],
      requests: 0,
      warnings: [],
      target,
      offered: offer,
      note:
        `This would change ${where} (${named}). Nothing was sent. ${input.binding.connectionTitle} can do it, ` +
        `but the person asking is not permitted to change ${offer.entityName} records here — whoever manages ` +
        "this workspace decides that. Say that, rather than that it is impossible.",
    };
  }

  /*
   * The call to make, ready to make. Given only instructions, a model
   * described the change and told the person a card was waiting — there was
   * none. Given the arguments, it makes the call.
   */
  const next =
    fields.length > 0 && offer.changes.some((change) => change.kind === "update")
      ? {
          tool: "change_record" as const,
          args: {
            connection: offer.connection,
            entity: offer.entity,
            kind: "update",
            ...(offer.singleton ? {} : { id: input.id }),
            values: input.changes.map((change) => ({ field: change.field, value: change.value })),
          },
        }
      : undefined;
  const how = next
    ? `Nothing has been proposed yet and no card is showing. Call change_record NOW, in this turn, with exactly ` +
      `these arguments: ${JSON.stringify(next.args)}` +
      (offer.parents.length > 0 ? ` — plus its ${offer.parents.join(" and ")} under "parents".` : ".") +
      " That puts the review in front of the person to approve. Never say a card is showing, or that anything " +
      "changed, before you have made that call."
    : `To propose it, call change_record (or remove_record to delete, or for an action that cannot be undone) ` +
      `with connection "${offer.connection}" and entity "${offer.entity}"` +
      (offer.singleton ? ", no id," : ", the record's id,") +
      (offer.parents.length > 0 ? ` its ${offer.parents.join(" and ")} under "parents",` : "") +
      " and every value to set under \"values\", using the field names listed here. Nothing has been proposed " +
      "yet and no card is showing: only change_record or remove_record puts one in front of the person. Nothing " +
      "has been changed either — never say it has until the change is confirmed.";
  /*
   * The note and the next call first. The engine quotes only the start of a
   * tool's result back to the model on the step after it runs — six hundred
   * characters — and a result that opened with the field listing had its
   * instructions cut off, so the model described the change instead of
   * proposing it. Key order is what JSON keeps, so it is what decides this.
   */
  return {
    note: `This would change ${where} (${named}). Nothing was sent. ${how}`,
    ...(next ? { next } : {}),
    performed: false,
    records: [],
    requests: 0,
    warnings: [],
    target,
    offered: offer,
  };
};

/* ── the chat-facing tool ──────────────────────────────────────────────── */

export const writeToolSchema = z.object({
  resource: z
    .string()
    .min(1)
    .max(120)
    .describe("Which kind of record would change. Use one of the names you were shown."),
  id: z.string().min(1).max(200).describe("The record's own identifier, or \"new\" for one that does not exist yet."),
  /* Flat, for the reason `toJsonSchema` gives: no records, no unions. */
  changes: z
    .array(
      z.object({
        field: z.string().max(120).describe("The field that would be set."),
        value: z.string().max(400).describe("What it would be set to."),
      }),
    )
    .default([])
    .describe("The fields that would be set, and to what."),
});

export type WriteToolArgs = z.infer<typeof writeToolSchema>;

/*
 * Named as a question on purpose. It was `write_record`, and asked to "set the
 * year built to 1999" a model reached for it — the name read as the way to
 * write — got a description back, and then, steered by the engine's
 * after-a-tool hints to answer in text, told the person a change was waiting
 * for approval when nothing had been proposed. The action is what proposes.
 */
export const WRITE_TOOL_NAME = "can_change_record";

export const WRITE_TOOL: LlmTool = {
  name: WRITE_TOOL_NAME,
  description:
    "ONLY for questions — \"can you change…?\", \"what can I edit on…?\" — and for looking up which " +
    "fields a change takes. It NEVER proposes or changes anything and shows the user nothing. When the " +
    "user asks you to create, change, delete or act on a record, do not call this: start the " +
    "change_record action (remove_record to delete) directly. If it returns a `next` call, make it.",
  schema: writeToolSchema,
};
