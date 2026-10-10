import type { ComponentCitation } from "../types.js";

/**
 * Where a change can be seen, as a citation chip on the chat's record of it.
 *
 * A change approved in the chat happened somewhere: a setting on another
 * screen, one row of a list. The action says where in its result
 * (`withCitation`). When it runs, `@freebirdai/server` saves a short message
 * in the conversation carrying that place as a citation, so the person can go
 * there when they choose, with nothing moving on its own. Where is said in the
 * app's own terms, a page as the host routes it and a CSS selector, so core
 * never needs to know about a router or the DOM.
 *
 * The selectors use the same `data-freebird-*` attributes the embed scanner
 * reads: `data-freebird-component` on a component's region,
 * `data-freebird-item` on one thing listed in it (a row, a card), and
 * `data-freebird-field` on one setting.
 */

/** Where an action's change can be seen, and what to say about it. */
export interface ActionCitation {
  /** The chip's words: "Showing · Approval". */
  readonly title: string;
  /** The page it is on, as the host routes it, e.g. `#/settings/billing`. Absent: the current page. */
  readonly page?: string;
  /** The element to scroll to and highlight once there. */
  readonly selector?: string;
  /** The chat's line about it: "Showing now needs approval." Absent: "Done: <the action's title>." */
  readonly summary?: string;
}

/** The key a result carries its citation under. */
export const CITATION_KEY = "freebirdCitation" as const;

/** An action's result, carrying where its change can be seen. */
export const withCitation = <T extends object>(result: T, citation: ActionCitation): T & { readonly [CITATION_KEY]: ActionCitation } => ({
  ...result,
  [CITATION_KEY]: citation,
});

/** The citation an action's result carries, or null when it carries none (or a malformed one). */
export const citationOf = (result: unknown): ActionCitation | null => {
  if (!result || typeof result !== "object") return null;
  const value = (result as Record<string, unknown>)[CITATION_KEY];
  if (!value || typeof value !== "object") return null;
  const { title, page, selector, summary } = value as Record<string, unknown>;
  if (typeof title !== "string" || title.trim() === "") return null;
  for (const optional of [page, selector, summary]) if (optional !== undefined && typeof optional !== "string") return null;
  return {
    title,
    ...(typeof page === "string" ? { page } : {}),
    ...(typeof selector === "string" ? { selector } : {}),
    ...(typeof summary === "string" ? { summary } : {}),
  };
};

/** The chip a citation becomes on a message (`toolPayload.citations`). */
export const toComponentCitation = (componentId: string, citation: ActionCitation): ComponentCitation => ({
  componentId,
  title: citation.title,
  directive: "highlight",
  kind: "component",
  ...(citation.selector !== undefined ? { selector: citation.selector } : {}),
  ...(citation.page !== undefined ? { page: citation.page } : {}),
});

/** `"x"` → `"\"x\""`, safe inside an attribute selector whatever the id holds. */
const quoted = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * A selector over the `data-freebird-*` attributes: a component's region, one
 * item listed in it, and one field in that item (or in the component).
 */
export const revealSelector = (target: { readonly component: string; readonly item?: string; readonly field?: string }): string =>
  [
    `[data-freebird-component=${quoted(target.component)}]`,
    ...(target.item !== undefined ? [`[data-freebird-item=${quoted(target.item)}]`] : []),
    ...(target.field !== undefined ? [`[data-freebird-field=${quoted(target.field)}]`] : []),
  ].join(" ");
