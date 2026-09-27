import type { RowAction } from "@freebirdai/dash-components";
import type { EntityWritesView } from "@freebirdai/dash-spec";
import type { RecordChangeRequest } from "../EntityRecordPage.jsx";

/** One existing record, as a change to it is addressed. */
export type RecordChangeBase = Pick<RecordChangeRequest, "connection" | "entity" | "entityName" | "id" | "parents">;

/**
 * What can be done to one record that exists: edit it, act on it, delete it —
 * in that order, the one that cannot be taken back last.
 *
 * The same list wherever a record is shown — its own page, a row on a board,
 * a row in another record's section — so the controls never disagree about
 * what a record allows. `writes` is what the server says the person may do;
 * nothing here decides that.
 */
export const recordChangeRequests = (
  base: RecordChangeBase,
  writes: EntityWritesView | undefined,
): RecordChangeRequest[] => {
  if (!writes) return [];
  // "Edit" reads right under a name — "Edit property"; without one, the endpoint says what it does.
  const named = Boolean(base.entityName);
  return [
    ...(writes.update && writes.update.mode !== "upsert"
      ? [{ ...base, kind: "update" as const, title: named ? "Edit" : writes.update.title }]
      : []),
    ...writes.actions.map((action) => {
      // An endpoint the specification gave no summary still needs something to be called.
      const title = action.title.trim() || action.id;
      return {
        ...base,
        kind: "action" as const,
        title,
        action: { id: action.id, title, danger: action.danger, ...(action.creates ? { creates: true } : {}) },
      };
    }),
    ...(writes.remove ? [{ ...base, kind: "delete" as const, title: named ? "Delete" : writes.remove.title }] : []),
  ];
};

/** Those requests as a row's menu, each opening its form or review. */
export const changeRowActions = (
  requests: readonly RecordChangeRequest[],
  open: (request: RecordChangeRequest) => void,
): RowAction[] =>
  requests.map((request) => ({
    id: `change-${request.kind}${request.action ? `-${request.action.id}` : ""}`,
    label: request.kind === "update" ? "Edit" : request.kind === "delete" ? "Delete" : request.title,
    tone: request.kind === "delete" || request.action?.danger ? ("danger" as const) : ("default" as const),
    onSelect: () => open(request),
  }));

/** One entry in a record page's "Add" or "More" menu. */
export interface ToolbarEntry {
  /** Stable, for tests and for finding it again: `record-change-action-credits`, `section-change-note-create`. */
  readonly id: string;
  readonly label: string;
  readonly request: RecordChangeRequest;
  readonly tone: "default" | "danger";
  /** Drawn with a rule above it: the start of the related records, or the one that cannot be undone. */
  readonly separated?: boolean;
}

/** A record page's changes, as the toolbar draws them. */
export interface RecordToolbar {
  readonly edit?: RecordChangeRequest;
  /** Everything that makes something new: on this record, then under it. */
  readonly add: readonly ToolbarEntry[];
  /** Every other change — actions, one-off settings under it — with deleting it last. */
  readonly more: readonly ToolbarEntry[];
}

/** "Create a payment reversal" is "Payment reversal" under "Add", which already says the verb. */
export const addLabel = (title: string): string => {
  const rest = title.replace(/^\s*(create|add|new)\s+(an?\s+|new\s+)?/i, "").trim();
  return rest ? `${rest[0]!.toUpperCase()}${rest.slice(1)}` : title;
};

/**
 * A record page's changes, grouped the way people look for them.
 *
 * Laid out one button apiece, a lease offered fifteen: "Create a credit",
 * "Create a payment", "Create a refund"… and then a charge, a note and a
 * renewal under it, each behind its section's name. So: Edit on its own;
 * one "Add" for everything that makes something new, the record's own first
 * and then what lives under it; and one menu for the rest, deleting the
 * record last. Nothing is dropped — only placed.
 */
export const recordToolbar = (
  own: readonly RecordChangeRequest[],
  sections: readonly { readonly section: { readonly entity: string }; readonly requests: readonly RecordChangeRequest[] }[],
): RecordToolbar | undefined => {
  const edit = own.find((request) => request.kind === "update");
  const ownId = (request: RecordChangeRequest): string =>
    `record-change-${request.kind}${request.action ? `-${request.action.id}` : ""}`;
  const tone = (request: RecordChangeRequest): "default" | "danger" =>
    request.kind === "delete" || request.action?.danger ? "danger" : "default";

  const ownAdds = own
    .filter((request) => request.kind === "action" && request.action?.creates)
    .map((request) => ({ id: ownId(request), label: addLabel(request.title), request, tone: tone(request) }));
  const underAdds = sections.flatMap(({ section, requests }) =>
    requests
      .filter((request) => request.kind === "create")
      .map((request) => ({
        id: `section-change-${section.entity}-${request.kind}`,
        label: addLabel(request.title),
        request,
        tone: "default" as const,
      })),
  );
  const add: ToolbarEntry[] = [
    ...ownAdds,
    ...underAdds.map((entry, index) => (index === 0 && ownAdds.length > 0 ? { ...entry, separated: true } : entry)),
  ];

  const changes: ToolbarEntry[] = [
    ...own
      .filter((request) => request.kind === "action" && !request.action?.creates)
      .map((request) => ({ id: ownId(request), label: request.title, request, tone: tone(request) })),
    ...sections.flatMap(({ section, requests }) =>
      requests
        .filter((request) => request.kind !== "create")
        .map((request) => ({
          id: `section-change-${section.entity}-${request.kind}`,
          label: request.title,
          request,
          tone: tone(request),
        })),
    ),
  ];
  const remove = own.find((request) => request.kind === "delete");
  const more: ToolbarEntry[] = [
    ...changes,
    ...(remove
      ? [{ id: ownId(remove), label: remove.title, request: remove, tone: "danger" as const, ...(changes.length > 0 ? { separated: true } : {}) }]
      : []),
  ];

  if (!edit && add.length === 0 && more.length === 0) return undefined;
  return { ...(edit ? { edit } : {}), add, more };
};
