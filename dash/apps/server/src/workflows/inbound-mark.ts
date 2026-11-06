import type { WorkflowCase, WorkflowNode } from "@freebirdai/dash-spec";
import { parseExpr, type ExprNode } from "@freebirdai/expr";

/**
 * Values from an email cannot drive Auto (Dash Evals, phase 2).
 *
 * A case an email started carries the mark: what the email said, what a
 * model read from it, and contact fields an email filled were all chosen by
 * whoever wrote it. An outside step whose settings read any of those runs on
 * Approve, unless the sender is trusted. This defeats most injection without
 * having to detect it: "mark invoice 1042 paid" can reach a step's settings,
 * but never past a person.
 *
 * What stays clean is who sent it and where it arrived (answering the sender
 * is not steered by them), and contact values a record or a member gave.
 * Words a step writes (a subject, a reply's wording) may quote the email.
 */

/** Settings that are words to send, not where or what to act on. */
const WORDS = new Set(["subject", "wording", "purpose", "instructions", "text", "title", "include", "prompt", "question", "details", "content", "includeLink", "send", "timeout", "agentId", "about", "channel"]);

/** Paths a case an email started may read without the mark. */
const CLEAN = new Set([
  "from",
  "from.address",
  "from.name",
  "mailbox",
  "id",
  "threadId",
  "channel",
  "contact.id",
  "contact.name",
  "contact.email",
  "contact.phone",
  "contact.emails",
  "contact.phones",
  "contact.types",
]);

/** Every field an expression reads, whole: `contact.email`, not just `contact`. */
const fieldPaths = (node: ExprNode): string[] => {
  switch (node.kind) {
    case "field":
      return [node.path.join(".")];
    case "unary":
      return fieldPaths(node.operand);
    case "binary":
      return [...fieldPaths(node.left), ...fieldPaths(node.right)];
    case "call":
      return node.args.flatMap(fieldPaths);
    case "array":
      return node.items.flatMap(fieldPaths);
    default:
      return [];
  }
};

/** The data paths a setting's templates read, as `@freebirdai/expr` parses them. One that does not parse reads something unknown. */
const pathsIn = (value: unknown): string[] => {
  const text = typeof value === "string" ? value : value !== null && typeof value === "object" ? JSON.stringify(value) : "";
  const out: string[] = [];
  for (const [, inner] of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    try {
      out.push(...fieldPaths(parseExpr((inner ?? "").trim()).root).map((path) => path.replace(/^row\./, "")));
    } catch {
      out.push("?");
    }
  }
  return out;
};

/** Whether the case was started by an email, and its sender is not trusted. */
export const marked = (one: Pick<WorkflowCase, "start" | "data">): boolean => {
  if (one.start.kind !== "message") return false;
  const inbound = (one.data.row as Record<string, unknown> | undefined)?.["inbound"] as { trust?: string } | undefined;
  return inbound?.trust !== "trusted";
};

/**
 * The settings of an outside step that read what an email chose, in a case
 * an email started. Empty: it may run on Auto.
 */
export const markedSettings = (one: Pick<WorkflowCase, "start" | "data">, node: Pick<WorkflowNode, "settings">): string[] => {
  if (!marked(one)) return [];
  const contact = (one.data.row as Record<string, unknown> | undefined)?.["contact"] as { inboundFields?: unknown } | undefined;
  const fromEmail = new Set(Array.isArray(contact?.inboundFields) ? (contact.inboundFields as string[]) : []);
  const clean = (path: string): boolean => {
    if (CLEAN.has(path)) return true;
    const [root, key] = path.split(".");
    /* A contact's own field is clean when a record or a member gave it; an email-filled one is not. */
    return root === "contact" && key !== undefined && path.split(".").length === 2 && key !== "inboundFields" && !fromEmail.has(key);
  };
  return Object.entries(node.settings)
    .filter(([key]) => !WORDS.has(key))
    .filter(([, value]) => pathsIn(value).some((path) => !clean(path)))
    .map(([key]) => key);
};
