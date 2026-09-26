import { pathShape, type WriteOpDef } from "./write.js";

/**
 * What a write endpoint does to one record type, read off its path.
 *
 * The same move `deriveResourceGraph` makes for reads, and for the same
 * reason: nearly every REST API is a collection, a record and a handful of
 * verbs wearing different words. `POST` on the collection makes one; `PUT` or
 * `PATCH` on the record changes it; `DELETE` on the record removes it; a
 * `POST` to a named step under the record — `/rentals/{id}/inactivationrequest`
 * — is an action. None of that needs to know which vendor it is reading.
 *
 * Worked out when it is asked for rather than stored, deliberately. The
 * resources it is read against are replaced wholesale whenever somebody saves
 * their relations or the map is refreshed, and a role stored on a resource
 * would silently vanish with it. A role derived here is always the one the
 * current structure implies.
 */

export type WriteMode = "create" | "replace" | "merge" | "upsert" | "delete" | "action";

export type WriteRole =
  | { readonly kind: "create"; readonly mode: "create" | "upsert" }
  | { readonly kind: "update"; readonly mode: "replace" | "merge" | "upsert" }
  | { readonly kind: "delete"; readonly mode: "delete" }
  | {
      readonly kind: "action";
      readonly mode: "action";
      readonly id: string;
      readonly danger: boolean;
      /** Makes a new record under this one rather than changing this one. */
      readonly creates: boolean;
    };

export interface RolePaths {
  /** The record type's collection endpoint path, or its only path when it is a singleton. */
  readonly list?: string | undefined;
  /** The one-record endpoint path. */
  readonly detail?: string | undefined;
  /**
   * A record that exists at most once under its parent — a unit's listing —
   * so its only path is both where it is read and where it is written.
   */
  readonly singleton: boolean;
  /** Every path the API answers GET on, by shape, to tell an action from a sub-resource. */
  readonly readShapes: ReadonlySet<string>;
}

/**
 * Words that mean an action takes something away. Tone only: it decides how
 * loudly the review asks, never whether an action is offered.
 */
const DANGER =
  /(delet|remov|cancel|void|inactivat|deactivat|terminat|archiv|revok|reject|disabl|suspend|clos|evict|writeoff|write-off)/i;

/**
 * Words that open the name of an action that makes something new under the
 * record — a lease's "Create a payment", a POST to `/leases/{id}/payments` —
 * rather than changing the record itself, like "Inactivate a property".
 * Placement only: it decides whether a control sits under "Add", never
 * whether it is offered.
 */
const CREATES = /^\s*(create|add|new|record|log|upload|register|schedule)\b/i;

/** Whether an action, by its name, makes a new record under the one it is on. */
export const actionCreates = (title: string): boolean => CREATES.test(title);

const ACTION_ID = /[^a-zA-Z0-9_-]/g;

/** One role for one write endpoint on one record type, or null when it is not this type's. */
export const writeRoleOf = (op: WriteOpDef, paths: RolePaths): WriteRole | null => {
  const shape = pathShape(op.path);
  const list = paths.list === undefined ? undefined : pathShape(paths.list);
  const detail = paths.detail === undefined ? undefined : pathShape(paths.detail);
  const hasBody = (op.body?.fields.length ?? 0) > 0;

  if (paths.singleton && list !== undefined && shape === list) {
    switch (op.method) {
      case "PUT":
        return { kind: "update", mode: "upsert" };
      case "PATCH":
        return { kind: "update", mode: "merge" };
      case "POST":
        return { kind: "create", mode: "create" };
      case "DELETE":
        return { kind: "delete", mode: "delete" };
    }
  }

  if (list !== undefined && shape === list && op.method === "POST" && !paths.singleton) {
    return { kind: "create", mode: "create" };
  }

  if (detail !== undefined && shape === detail) {
    switch (op.method) {
      case "PUT":
        return { kind: "update", mode: "replace" };
      case "PATCH":
        return { kind: "update", mode: "merge" };
      // Stripe-style: a POST to the record itself, with a body, changes it.
      case "POST":
        return hasBody ? { kind: "update", mode: "merge" } : null;
      case "DELETE":
        return { kind: "delete", mode: "delete" };
    }
  }

  // A named step under the record, which the API does not also let you read.
  if (detail !== undefined && op.method === "POST" && shape.startsWith(`${detail}/`)) {
    const rest = shape.slice(detail.length + 1);
    if (rest.length > 0 && !rest.includes("/") && !rest.includes("{}") && !paths.readShapes.has(shape)) {
      const id = rest.replace(ACTION_ID, "-").slice(0, 64);
      const creates = actionCreates(op.title);
      // Making something new takes nothing away, whatever the words around it say.
      return { kind: "action", mode: "action", id, danger: !creates && DANGER.test(`${rest} ${op.title}`), creates };
    }
  }

  return null;
};

/**
 * Two actions that undo each other: `inactivationrequest` and
 * `reactivationrequest`, `archive` and `unarchive`. Read off the names, so a
 * journal entry can name the step that reverses it. A hint for whoever
 * reverses a change later — never something executed on its own.
 */
export const pairedAction = (id: string, others: readonly string[]): string | undefined => {
  const stem = (name: string): string => name.toLowerCase().replace(/^(in|de|re|un|dis)/, "");
  const own = stem(id);
  return others.find((other) => other !== id && stem(other) === own);
};

/** Which of two candidates for the same role to offer: the safer one. */
export const MODE_PREFERENCE: Readonly<Record<WriteMode, number>> = {
  // Changing only what was changed cannot clear what an edit never touched.
  merge: 0,
  upsert: 1,
  create: 1,
  replace: 2,
  delete: 0,
  action: 0,
};
