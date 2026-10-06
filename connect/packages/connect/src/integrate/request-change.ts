import { getOp, type ConnectionSpec, type ReadBody, type ReadSafety } from "@freebirdai/connect-spec";
import { readSideOf, type KnownWrite } from "../connector/host.js";
import type { ConnectionPatch } from "./patch.js";
import { namedInDocs } from "./templates.js";

/**
 * A model's change to the request itself — its method, path, body, GraphQL
 * document and how a list is written — held to the documentation.
 *
 * The runtime already reads with a body, with GraphQL, with lists written
 * three ways; a repair could not say so, and a body sent a check to write
 * connector code for an API that needed none. Here it can, within limits a
 * change to the request needs more than any other:
 *
 * - a path must be one the documentation names, its ids inputs it names;
 * - a POST is never one of the catalog's endpoints that change the account,
 *   unless it is a search or an export the documentation reads with;
 * - a POST read says why it is believed to read: a GraphQL query by its
 *   protocol, anything else by the documentation's word — which keeps it from
 *   being warmed in the background or sent twice;
 * - a GET sends no body.
 */

export interface RequestProposal {
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly bodyType?: string | undefined;
  readonly body?: string | undefined;
  readonly variables?: string | undefined;
  readonly lists?: readonly { readonly name: string; readonly style: string; readonly explode: boolean }[] | undefined;
}

type OpChange = NonNullable<ConnectionPatch["ops"]>[string];

const PLACEHOLDER = /^\{\{?\s*(param\.)?[A-Za-z_][\w-]*\s*\}?\}$/;

/** Two endpoint paths the same but for their ids: `/orders/{{param.id}}/archive` and `/orders/7/archive`. */
const samePath = (a: string, b: string): boolean => {
  const left = a.replace(/\/+$/, "").split("/");
  const right = b.replace(/\/+$/, "").split("/");
  return left.length === right.length && left.every((segment, index) => segment === right[index] || PLACEHOLDER.test(segment) || PLACEHOLDER.test(right[index]!));
};

export const requestChange = (
  proposal: RequestProposal,
  connection: ConnectionSpec,
  opId: string,
  context: { readonly ground: string; readonly writes: readonly KnownWrite[] },
): { readonly change: OpChange } | { readonly refused: string } | null => {
  const op = getOp(connection, opId);
  if (!op) return null;
  if (!proposal.method && !proposal.path && !proposal.bodyType && !(proposal.lists && proposal.lists.length > 0)) return null;
  const change: {
    -readonly [key in keyof OpChange]: OpChange[key];
  } = {};

  let path = op.path;
  if (proposal.path) {
    const given = proposal.path.trim();
    if (!given.startsWith("/") || /:\/\//.test(given)) return { refused: `"${given}" is not an endpoint's path` };
    if (!namedInDocs(given, context.ground, connection)) return { refused: `${given} is not a path the documentation names` };
    for (const [, name] of given.matchAll(/\{([A-Za-z_][\w-]*)\}/g)) {
      const declared = op.params.some((param) => param.name === name && param.in === "path");
      if (!declared && !new RegExp(`\\{${name}\\}|:${name}\\b`).test(context.ground))
        return { refused: `{${name}} in ${given} is not an input the documentation names` };
    }
    path = given.replace(/\{([A-Za-z_][\w-]*)\}/g, "{{param.$1}}");
    if (path !== op.path) change.path = path;
  }

  const method = (proposal.method ?? (proposal.bodyType ? "POST" : op.method)).toUpperCase();
  if (method !== "GET" && method !== "POST") return { refused: `${method} is not a read` };
  if (method !== op.method) change.method = method;

  if (method === "GET" && proposal.bodyType) return { refused: "a GET sends no body" };
  if (method === "POST") {
    /* Never one of the account's changes, whatever it is called: only a search or an export reads with one. */
    const write = context.writes.find((one) => one.method.toUpperCase() === "POST" && samePath(one.path, path));
    if (write && readSideOf(write.path) !== "search" && readSideOf(write.path) !== "export-create")
      return { refused: `POST ${path} is an endpoint that changes things in the account` };

    let body: ReadBody | undefined;
    if (proposal.bodyType && proposal.body !== undefined) {
      try {
        if (proposal.bodyType === "json") body = { type: "json", template: JSON.parse(proposal.body) as unknown };
        else if (proposal.bodyType === "form") {
          const fields = JSON.parse(proposal.body) as Record<string, unknown>;
          body = { type: "form", template: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)])) };
        } else if (proposal.bodyType === "graphql")
          body = {
            type: "graphql",
            query: proposal.body,
            variables: proposal.variables ? (JSON.parse(proposal.variables) as Record<string, unknown>) : {},
          };
        else if (proposal.bodyType === "xml") body = { type: "xml", template: proposal.body, contentType: "text/xml; charset=utf-8" };
      } catch {
        return { refused: "the body is not written as its type says" };
      }
    }
    if (body) change.body = body;
    const graphql = (body ?? op.body)?.type === "graphql";
    const safety: ReadSafety = graphql
      ? { basis: "graphql-query", note: "A GraphQL query, from a repair; a document that could change something is refused." }
      : { basis: "docs-inferred", note: `The documentation reads ${path} with POST (a repair).` };
    if (change.method || change.body || !op.readSafety) change.readSafety = safety;
  }

  for (const list of proposal.lists ?? []) {
    if (!op.params.some((param) => param.name === list.name)) continue;
    if (list.style !== "form" && list.style !== "spaceDelimited" && list.style !== "pipeDelimited") continue;
    change.lists = { ...(change.lists ?? {}), [list.name]: { style: list.style, explode: list.explode } };
  }
  return Object.keys(change).length > 0 ? { change } : null;
};
