import { extractRows, parsePath } from "@freebirdai/dash-expr";
import type { EntitySpec, GraphOp, ResourceSpec } from "@freebirdai/dash-spec";
import { entityGraph, parentsFrom, readField } from "@freebirdai/dash-spec";
// The budgets live in the spec package: the screen that offers this check
// has to state its cost before it is agreed to, and must quote the same
// number this spends.
export { VERIFY_BUDGET_DEFAULT, VERIFY_BUDGET_MAX } from "@freebirdai/dash-spec";

/**
 * Checking a description against a real account.
 *
 * The gate on sharing, and the only part of this whole layer that costs
 * somebody's API quota. Everything else — what the records are, what their
 * fields mean, which of them point at each other — is read out of a
 * specification and could be confidently wrong in ways no amount of re-reading
 * would reveal. Two claims can only be settled by asking:
 *
 * - **This field identifies a record.** A path says `{taskId}` and the body
 *   says `Id`, and no specification states the correspondence. Until a real
 *   response carries it, the identity is a convention rather than a fact.
 * - **This field points at that record type.** A name ending in `Id` is a
 *   guess; a guess that resolves against the target's own endpoint is not.
 *
 * Everything here is budgeted, and the budget is the point. A real API has a
 * hundred record types and a hundred and thirty links, so an unbounded check
 * is hundreds of requests against an account that rate-limits — which is why
 * this stops at a stated number, stops the moment it is refused, and reports
 * where it got to rather than silently doing less than asked.
 *
 * Nothing here ever marks something *un*verified: a record type that could not
 * be reached this time is simply not evidence either way, and downgrading it
 * would make a rate limit look like a discovery.
 */

/** How many links are checked per record type, before moving on. */
const REFERENCES_PER_ENTITY = 2;

export interface VerifyRead {
  (
    op: string,
    params: Readonly<Record<string, string | number | boolean>>,
  ): Promise<{ readonly ok: boolean; readonly body: unknown; readonly status?: number }>;
}

export interface VerifyInput {
  readonly entities: readonly EntitySpec[];
  readonly resources: readonly ResourceSpec[];
  /** The endpoints this connection actually carries. */
  readonly carried: ReadonlySet<string>;
  /** Where an endpoint's rows sit in its body. */
  readonly rowsPathOf: (op: string) => string | undefined;
  readonly read: VerifyRead;
  /** How many requests this may spend. */
  readonly budget: number;
  /**
   * The endpoints' paths, so a link to a record that lives under a parent is
   * followed with the parent's id too. Without them such a link is followed
   * by its own id alone, as before.
   */
  readonly ops?: readonly GraphOp[] | undefined;
  /** When this run happened, stamped on each record type it read. */
  readonly now?: string | undefined;
}

export interface VerifyResult {
  readonly entities: readonly EntitySpec[];
  readonly spent: number;
  /** Why it stopped early, when it did. */
  readonly stopped: "budget" | "refused" | "rejected" | null;
  readonly checked: number;
  readonly identitiesConfirmed: number;
  readonly referencesResolved: number;
  readonly notes: readonly string[];
}

/** One value off a row, by the path the API spells for it. */
const valueAt = readField;

const present = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== "";

/**
 * Confirm what can be confirmed, within a budget.
 *
 * Takes a `read` rather than a connection so the deciding can be exercised
 * without an account: what counts as confirmation is the interesting part, and
 * it should not need somebody's quota to check.
 */
export const verifyRecords = async (input: VerifyInput): Promise<VerifyResult> => {
  const byResource = new Map(input.resources.map((resource) => [resource.id, resource]));
  const notes: string[] = [];
  const confirmed = new Map<string, { identity: boolean; references: Set<string> }>();
  /** Record types whose rows this run read, to stamp when it did. */
  const read = new Set<string>();
  const graph = input.ops
    ? entityGraph({ entities: input.entities, resources: input.resources, ops: input.ops })
    : null;

  /*
   * The ones never read first, then the longest since. A budget smaller than
   * the API — sixty requests against Buildium's 108 record types — used to
   * spend itself on the same first sixty every run and never reach the rest;
   * this way each run carries on where the last one stopped.
   */
  const ordered = [...input.entities].sort((a, b) =>
    (a.readAt ?? "").localeCompare(b.readAt ?? ""),
  );

  let spent = 0;
  let checked = 0;
  let stopped: VerifyResult["stopped"] = null;

  /**
   * The rows a response carries, or none.
   *
   * A collection and a by-id endpoint answer with different shapes, and reading
   * one as the other is how an empty account comes to look like a description
   * that is wrong: an envelope holding an empty list, read as a single record,
   * is one row - the envelope - so "no tasks on this account" turns into "tasks
   * do not carry Id". The single-record reading is therefore only ever applied
   * where a single record is what was asked for.
   */
  const rowsFrom = (body: unknown, op: string, single: boolean): readonly unknown[] | null => {
    const stated = input.rowsPathOf(op);
    if (stated) {
      try {
        const rows = extractRows(parsePath(stated), body);
        // An empty collection is an answer; an empty by-id result is a miss,
        // and worth the reading below before concluding anything.
        if (rows.length > 0 || !single) return rows;
      } catch {
        /* A path that will not parse is not evidence about the body. */
      }
    }
    if (single) return body && typeof body === "object" && !Array.isArray(body) ? [body] : [];
    // A bare array is unambiguous. An envelope with no stated path is not:
    // its rows are in there somewhere and this cannot say where.
    return Array.isArray(body) ? body : null;
  };

  /**
   * What a failed read means for the rest of the run.
   *
   * Two failures are about the connection rather than about any one record
   * type, and both make everything after them meaningless: a rate limit, and a
   * credential the API will not accept. Carrying on through either would spend
   * the whole budget collecting failures and then report "nothing confirmed",
   * which reads exactly like a description that is wrong. Anything else is
   * about this endpoint alone and is simply skipped.
   */
  const halting = (status: number | undefined): "refused" | "rejected" | null => {
    if (status === 429) return "refused";
    if (status === 401 || status === 403) return "rejected";
    return null;
  };

  const HALT_NOTE: Record<"refused" | "rejected", string> = {
    refused: "The API stopped answering, so the rest were left unchecked.",
    rejected:
      "The API would not accept the stored key, so nothing could be checked. Nothing was marked wrong.",
  };

  outer: for (const entity of ordered) {
    if (spent >= input.budget) {
      stopped = "budget";
      break;
    }

    const listOp = byResource.get(entity.resource)?.listOp;
    /*
     * Nothing to ask, or nothing to ask it of. A record type with no identity
     * has no claim to check, and one whose collection this connection does not
     * carry cannot be read at all.
     */
    if (!entity.identity || !listOp || !input.carried.has(listOp)) continue;

    spent += 1;
    const listed = await input.read(listOp, {});
    if (!listed.ok) {
      const halt = halting(listed.status);
      if (halt) {
        stopped = halt;
        notes.push(HALT_NOTE[halt]);
        break;
      }
      continue;
    }

    checked += 1;
    read.add(entity.id);
    const rows = rowsFrom(listed.body, listOp, false);
    if (rows === null) {
      /*
       * The response came back and this could not find the records in it,
       * which is a fact about the reading rather than about the account. It
       * would be wrong to report an empty account, and wronger still to
       * conclude anything about the description.
       */
      notes.push(
        `Could not tell where the ${entity.name.many.toLowerCase()} are in that response, so they were left unchecked.`,
      );
      continue;
    }
    if (rows.length === 0) {
      /*
       * An account with none of these records is not evidence against the
       * description — it is an account with none of them, which is ordinary.
       */
      notes.push(`No ${entity.name.many.toLowerCase()} on this account to check against.`);
      continue;
    }

    const record = confirmed.get(entity.id) ?? { identity: false, references: new Set<string>() };
    confirmed.set(entity.id, record);

    if (rows.some((row) => present(valueAt(row, entity.identity!.field)))) {
      record.identity = true;
    } else {
      notes.push(
        `${entity.name.many} do not carry "${entity.identity.field}", so what identifies one is still a guess.`,
      );
      // Without an identity there is nothing to resolve a link *from*.
      continue;
    }

    let followed = 0;
    for (const field of entity.fields) {
      if (followed >= REFERENCES_PER_ENTITY) break;
      const reference = field.reference;
      // Only a plain scalar: an array or a nested object needs a different
      // question, and answering the easy one would overstate what was checked.
      if (!reference || reference.holds !== "scalar") continue;

      const target = input.entities.find((one) => one.id === reference.entity);
      const detail = target ? byResource.get(target.resource) : undefined;
      if (!detail?.detailOp || !detail.detailParam || !input.carried.has(detail.detailOp)) continue;

      /*
       * A target that lives under a parent is asked for with the parent's id
       * off the same row — a work order's unit, with the work order's
       * property. A row that carries the link but not the parent cannot
       * address the target, so the next row is tried.
       */
      const reach = graph
        ?.referencesOf(entity.id)
        .find((one) => one.field === field.path)?.reach;
      const linked = reach?.mode === "record" ? (reach.parents ?? []) : [];
      let id: unknown;
      let parents: Record<string, string> | null = {};
      for (const row of rows) {
        const value = valueAt(row, field.path);
        if (!present(value)) continue;
        const found = parentsFrom(linked, row);
        if (found === null) continue;
        id = value;
        parents = found;
        break;
      }
      if (id === undefined || parents === null) continue;

      if (spent >= input.budget) {
        stopped = "budget";
        break outer;
      }
      spent += 1;
      followed += 1;
      const opened = await input.read(detail.detailOp, {
        ...parents,
        [detail.detailParam]: id as string | number,
      });
      if (!opened.ok) {
        const halt = halting(opened.status);
        if (halt) {
          stopped = halt;
          notes.push(HALT_NOTE[halt]);
          break outer;
        }
        notes.push(
          `"${field.label ?? field.path}" did not resolve to a ${target?.name.one.toLowerCase() ?? "record"}, so that link is still a guess.`,
        );
        continue;
      }
      if ((rowsFrom(opened.body, detail.detailOp, true) ?? []).length > 0)
        record.references.add(field.path);
    }
  }

  /*
   * Written back as evidence, never as a downgrade: something this run could
   * not reach keeps whatever it already had, so a rate limit cannot look like
   * a discovery.
   */
  let identitiesConfirmed = 0;
  let referencesResolved = 0;
  const entities = input.entities.map((before) => {
    // Stamped whenever its rows were read, whatever the read confirmed.
    const entity =
      read.has(before.id) && input.now ? { ...before, readAt: input.now } : before;
    const found = confirmed.get(entity.id);
    if (!found) return entity;
    if (found.identity) identitiesConfirmed += 1;
    referencesResolved += found.references.size;

    return {
      ...entity,
      ...(found.identity && entity.identity
        ? { identity: { ...entity.identity, observed: true }, verified: true }
        : {}),
      fields: entity.fields.map((field) =>
        field.reference && found.references.has(field.path)
          ? { ...field, reference: { ...field.reference, verified: true } }
          : field,
      ),
    };
  });

  return {
    entities,
    spent,
    stopped,
    checked,
    identitiesConfirmed,
    referencesResolved,
    notes,
  };
};
