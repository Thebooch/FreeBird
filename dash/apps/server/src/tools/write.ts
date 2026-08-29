import type { LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import type { ToolBinding, ToolResult } from "./types.js";

/**
 * Changing a record — declared, described, and refused.
 *
 * The fourth verb exists so the assistant can answer "can you update this?"
 * with the truth. Without it the model has two ways to be wrong and no way to
 * be right: invent a capability it does not have, or refuse in a way that
 * sounds like a policy when it is a fact about the connection.
 *
 * **Nothing in the spec can express a write.** `opDefSchema.method` is
 * `z.literal("GET")`, commented as read-only by construction *so that no spec
 * and no generated binding can ever mutate a connected account*. That is a
 * structural guarantee rather than a check, and it is worth more than this
 * tool would be — so this reports it rather than routing around it.
 *
 * What it does do is say precisely what *would* happen: which record, on which
 * API, and what would have to exist first. That turns a dead end into a
 * decision somebody can make, and gives the eventual consent flow a shape to
 * land in — a confirmation, a dry run, an audit line — rather than a blank
 * file.
 */

/** Why a write cannot be performed. One reason, in the API's own terms. */
export type WriteRefusal =
  /** The connection exposes no endpoint that changes anything. */
  | "read-only-connection"
  /** The resource is not one this workspace knows how to address. */
  | "unknown-resource";

export interface WritePlan extends ToolResult {
  /** Always false for now. Present so callers are written for both cases. */
  readonly performed: false;
  readonly refusal: WriteRefusal;
  /** What would have been changed, named, so the reply is specific. */
  readonly target?: {
    readonly resource: string;
    readonly connection: string;
    readonly id: string;
    readonly fields: readonly string[];
  };
}

export interface WriteInput {
  readonly binding: ToolBinding | null;
  readonly resource: string;
  readonly id: string;
  readonly changes: ReadonlyArray<{ readonly field: string; readonly value: string }>;
}

/**
 * Describe the change, then decline it.
 *
 * Deliberately shaped like the other verbs — same result type, same honesty
 * about what was and was not done — so the day writes are possible this
 * becomes an implementation rather than a redesign.
 */
export const planWrite = (input: WriteInput): WritePlan => {
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

  return {
    performed: false,
    refusal: "read-only-connection",
    records: [],
    requests: 0,
    warnings: [],
    target: {
      resource: input.binding.resource,
      connection: input.binding.connectionTitle,
      id: input.id,
      fields,
    },
    /*
     * The reason is structural and worth stating as such. "I am not allowed
     * to" invites somebody to look for the permission; "this cannot issue
     * anything but a read" tells them what would actually have to change.
     */
    note:
      `This would change ${input.binding.resource} ${input.id} on ` +
      `${input.binding.connectionTitle} (${named}). It was not done, and nothing was sent. ` +
      "This dashboard only ever issues reads, by construction rather than by setting — a " +
      "limit of this dashboard, NOT of the API, which may well allow the change through its " +
      "own interface. Say it that way round.",
  };
};

/* ── the chat-facing tool ──────────────────────────────────────────────── */

export const writeToolSchema = z.object({
  resource: z
    .string()
    .min(1)
    .max(120)
    .describe("Which kind of record would change. Use one of the names you were shown."),
  id: z.string().min(1).max(200).describe("The record's own identifier."),
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

export const WRITE_TOOL_NAME = "write_record";

export const WRITE_TOOL: LlmTool = {
  name: WRITE_TOOL_NAME,
  description:
    "Say what changing a record would do. Call this when the user asks you to create, " +
    "update or delete something, rather than answering from memory about whether you can. " +
    "It never changes anything: this server issues reads only, by construction, so the " +
    "result names the record and the fields and explains that nothing was sent. Use its " +
    "answer as your answer - it is more useful and more accurate than a flat refusal.",
  schema: writeToolSchema,
};
