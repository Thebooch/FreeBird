import { digest } from "@freebirdai/contracts";
import { AdapterError, type AdapterRegistry, type RestAdapter } from "../adapters/index.js";
import type {
  CatalogEntry,
  ConnectionSpec,
  EntitySpec,
  ResourceSpec,
  WriteOpDef,
  WriteTarget,
} from "@freebirdai/connect-spec";
import {
  entityById,
  entityGraph,
  getOp,
  pathParamNames,
  readField,
  resolveRange,
  valueForParam,
  writesEmpty,
  writesView,
} from "@freebirdai/connect-spec";
import { Priority } from "../cache/gate.js";
import type { QueryCache } from "../cache/queryCache.js";
import type { CatalogStore } from "../catalog.js";
import { scopeOpAuth } from "../catalog.js";
import type { LastSeen } from "../keeper/keeper.js";
import type { ConnectionRepository } from "../connections.js";
import type { SecretRepository } from "../vault.js";
import type { WriteActor, WritePermission, WritePolicy } from "./policy.js";
import { buildBody, currentValue, labelOf, settable, type FieldError } from "./body.js";
import type { WriteEvent, WriteJournal, WriteOnBehalfOf, WriteReversal, WriteVia } from "./journal.js";
import { PENDING_TTL_MS, PendingWrites, type PendingWrite, type WriteIntent, type WriteReview } from "./pending.js";

/**
 * The only thing in Dash that changes a connected account.
 *
 * Two steps, always, and never one:
 *
 * 1. **prepare** reads the record as it is right now, builds exactly what
 *    will be sent, and hands back a review — before and after, what may be
 *    cleared, what cannot be undone — with a digest over all of it.
 * 2. **commit** takes a person's yes to that digest, checks nobody else has
 *    changed the record since, and sends the request once.
 *
 * The assistant can ask for step one. Only a person's click reaches step
 * two. Every attempt, sent or refused, leaves a complete event in the
 * journal, and every step asks the policy first — which in the open-source
 * build always says yes, and in a managed build is where permissions live.
 */

export type WriteErrorCode =
  | "not-found"
  | "not-offered"
  | "switched-off"
  | "forbidden"
  | "invalid"
  | "incomplete-address"
  | "expired"
  | "not-yours"
  | "already-sent"
  | "digest-mismatch"
  | "stale"
  | "upstream";

export class WriteError extends Error {
  constructor(
    readonly status: number,
    readonly code: WriteErrorCode,
    message: string,
    readonly extra: {
      readonly fields?: readonly FieldError[];
      readonly detail?: string;
      readonly upstreamStatus?: number;
      readonly outcome?: "not-sent" | "unknown";
      readonly review?: WriteReview;
    } = {},
  ) {
    super(message);
    this.name = "WriteError";
  }
}

export interface WriteServiceDeps {
  readonly store: ConnectionRepository;
  readonly catalog: CatalogStore | undefined;
  /** Only read, and through the credential broker, so an OAuth token is always current. */
  readonly keys: Pick<SecretRepository, "get"> | { get(keyRef: string): Promise<string | null> };
  readonly registry: AdapterRegistry;
  readonly rest: RestAdapter;
  readonly queries: QueryCache;
  readonly seen: LastSeen;
  readonly policy: WritePolicy;
  readonly journal: WriteJournal;
  /** The shared gate and cooldown: a change waits its turn like any request, just first. */
  readonly upstream: <T>(connection: string, run: () => Promise<T>, priority?: Priority) => Promise<T>;
  readonly now?: () => number;
}

export interface CommitResult {
  readonly status: "succeeded";
  readonly connection: string;
  readonly entity: string;
  readonly kind: WriteIntent["kind"];
  readonly key?: { readonly id?: string; readonly parents?: Readonly<Record<string, string>> } | undefined;
  /** The record as the API returned it, where it did. */
  readonly record?: unknown;
  readonly changed: readonly string[];
  /** What was made stale, so the browser can drop the same answers. */
  readonly invalidated: { readonly connection: string; readonly ops: readonly string[] };
  readonly title: string;
  /** The journal event this change was recorded under. */
  readonly eventId: string;
  /** How to undo it, as far as the API allows: the same hint the journal keeps. */
  readonly reversal?: WriteReversal | undefined;
}

interface Resolved {
  readonly connection: ConnectionSpec;
  readonly entry: CatalogEntry;
  readonly entity: EntitySpec;
  readonly resource: ResourceSpec;
  readonly target: WriteTarget;
  readonly graph: ReturnType<typeof entityGraph>;
}

const permissionFor = (kind: WriteIntent["kind"]): WritePermission =>
  kind === "create"
    ? "records.create"
    : kind === "update"
      ? "records.update"
      : kind === "delete"
        ? "records.delete"
        : "records.act";

/**
 * A record type by its id, or — as the assistant says it — by its own name.
 *
 * "listing" is one API's `unit-2-listing`, whose name is Listing. Only a
 * match that is unique counts: two record types that could both be meant is
 * a question for whoever asked, not a guess to make on their account.
 */
export const findEntity = (entities: readonly EntitySpec[], wanted: string): EntitySpec | undefined => {
  const exact = entityById(entities, wanted);
  if (exact) return exact;
  const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = squash(wanted);
  for (const test of [
    (one: EntitySpec) => squash(one.id) === key,
    (one: EntitySpec) => squash(one.name.one) === key || squash(one.name.many) === key,
  ]) {
    const hits = entities.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return undefined;
  }
  return undefined;
};

const KIND_WORD: Record<WriteIntent["kind"], string> = {
  create: "create",
  update: "change",
  delete: "delete",
  action: "act on",
};

export class WriteService {
  readonly pending: PendingWrites;
  private readonly now: () => number;

  constructor(private readonly deps: WriteServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.pending = new PendingWrites(this.now);
  }

  /* ── what can be done ─────────────────────────────────────────────── */

  /** The graph a connection's writes are read against: the same one its pages use. */
  graphFor(connection: ConnectionSpec): { entry: CatalogEntry | undefined; graph: ReturnType<typeof entityGraph> } {
    const entry = connection.catalog ? this.deps.catalog?.get(connection.catalog) : undefined;
    const graph = entityGraph({
      entities: entry?.entities ?? [],
      resources: connection.resources,
      ops: connection.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
      writes: entry?.writes ?? [],
    });
    return { entry: entry ?? undefined, graph };
  }

  /**
   * Whether this principal may ask for this kind of change on this record type
   * here. The record type is read the same way `prepare` reads it — by id, or
   * uniquely by name — so every gate agrees on which record type was meant.
   */
  async allowed(principal: WriteActor, connection: ConnectionSpec, entity: string, kind: WriteIntent["kind"]): Promise<boolean> {
    const entry = connection.catalog ? this.deps.catalog?.get(connection.catalog) : undefined;
    const id = (entry ? findEntity(entry.entities, entity)?.id : undefined) ?? entity;
    const decision = await this.deps.policy.can(principal, permissionFor(kind), { connection: connection.id, entity: id });
    return decision.ok;
  }

  private async resolve(principal: WriteActor, intent: WriteIntent): Promise<Resolved> {
    const connection = this.deps.store.getConnection(intent.connection);
    if (!connection) throw new WriteError(404, "not-found", `There is no connection "${intent.connection}".`);
    const { entry, graph } = this.graphFor(connection);
    const entity = entry ? findEntity(entry.entities, intent.entity) : undefined;
    const resource = entity ? connection.resources.find((one) => one.id === entity.resource) : undefined;
    if (!entry || !entity || !resource) {
      // Name what can be changed here, so whoever asked can ask again correctly.
      const open = (entry?.entities ?? []).filter((one) => !writesEmpty(writesView(graph.writesOf(one.id))));
      throw new WriteError(
        404,
        "not-found",
        `"${intent.entity}" is not a kind of record ${connection.title} describes.` +
          (open.length > 0
            ? ` Record types that can be changed here: ${open.map((one) => `${one.id} (${one.name.one})`).join(", ")}.`
            : ""),
      );
    }

    const decision = await this.deps.policy.can(principal, permissionFor(intent.kind), {
      connection: connection.id,
      entity: entity.id,
    });
    if (!decision.ok) throw new WriteError(403, "forbidden", decision.reason);

    const writes = graph.writesOf(entity.id);
    const target =
      intent.kind === "create"
        ? writes.create
        : intent.kind === "update"
          ? writes.update
          : intent.kind === "delete"
            ? writes.remove
            : writes.actions.find((action) => action.action?.id === intent.action);
    if (!target) {
      const what = intent.kind === "action" ? `"${intent.action ?? ""}"` : `${KIND_WORD[intent.kind]} a ${entity.name.one.toLowerCase()}`;
      throw new WriteError(404, "not-offered", `${connection.title} has no endpoint to ${what}.`);
    }
    if (!target.confirmed) {
      throw new WriteError(409, "switched-off", `"${target.title}" has been switched off for ${connection.title}.`);
    }
    return { connection, entry, entity, resource, target, graph };
  }

  /** Every path value the write endpoint needs, or which ones are missing. */
  private addressOf(resolved: Resolved, intent: WriteIntent): Record<string, string> {
    const { target, entity } = resolved;
    const params: Record<string, string> = {};
    const known: Record<string, string> = { ...(intent.parents ?? {}) };
    if (target.own) {
      if (!intent.id) {
        throw new WriteError(400, "incomplete-address", `Say which ${entity.name.one.toLowerCase()} to ${KIND_WORD[intent.kind]}.`);
      }
      params[target.own.param] = intent.id;
    }
    /*
     * A record that exists once under its parent has no id of its own — a
     * unit's listing is the unit's id — so an id given for it is its parent's,
     * when that is the one part of the address still missing.
     */
    if (!target.own && intent.id) {
      const unfilled = target.parents.filter((part) => valueForParam(known, part.param) === undefined);
      if (unfilled.length === 1) known[unfilled[0]!.param] = intent.id;
    }
    const missing: string[] = [];
    for (const part of target.parents) {
      const value = valueForParam(known, part.param) ?? (part.param === target.own?.param ? intent.id : undefined);
      if (value === undefined) missing.push(part.entity ? (entityById(resolved.entry.entities, part.entity)?.name.one ?? part.param) : part.param);
      else params[part.param] = value;
    }
    if (missing.length > 0) {
      throw new WriteError(
        400,
        "incomplete-address",
        `This ${entity.name.one.toLowerCase()} can only be changed through the ${missing.join(" and ")} it belongs to, and that was not given.`,
      );
    }
    return params;
  }

  /**
   * The record as it is right now, straight from the API.
   *
   * Never from the cache. A cached copy on cooldown is served at any age,
   * and a change reviewed against it would show a "before" that is not what
   * the API holds — and its stale check would compare against the same wrong
   * copy. Only a fresh answer counts; `null` means there is none (a
   * singleton that has not been made yet).
   */
  private async readBefore(resolved: Resolved, params: Readonly<Record<string, string>>, intent: WriteIntent): Promise<unknown> {
    const { connection, resource, target } = resolved;
    const opId = resource.detailOp ?? resource.listOp;
    if (!opId) return undefined;
    const op = getOp(connection, opId);
    if (!op) return undefined;

    const known: Record<string, string> = { ...params, ...(intent.parents ?? {}) };
    if (intent.id && resource.detailParam) known[resource.detailParam] = intent.id;
    const filters: Record<string, string> = {};
    for (const name of pathParamNames(op.path)) {
      const value = valueForParam(known, name);
      if (value === undefined) return undefined;
      filters[name] = value;
    }

    this.deps.registry.addConnection(connection);
    try {
      const result = await this.deps.upstream(
        connection.id,
        () =>
          this.deps.registry.fetch(connection.id, op.id, {}, {
            params: { range: resolveRange({ preset: "30d", now: this.now() }), filters },
            now: this.now(),
            resolveSecret: async (keyRef) => (await this.deps.keys.get(keyRef)) ?? null,
          }),
        Priority.Interactive,
      );
      this.deps.queries.accounting.upstream(connection.id, 0, this.now());
      const rows = op.rowsPath && op.rowsPath !== "$" ? readField(result.body, op.rowsPath.replace(/^\$\./, "")) : result.body;
      return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
    } catch (error) {
      if (error instanceof AdapterError && error.upstreamStatus === 404) {
        if (target.mode === "upsert") return null;
        throw new WriteError(404, "not-found", `That ${resolved.entity.name.one.toLowerCase()} no longer exists on ${connection.title}.`);
      }
      if (error instanceof AdapterError) {
        throw new WriteError(error.status === 429 ? 429 : 502, "upstream", error.userMessage, {
          ...(error.upstreamStatus !== undefined ? { upstreamStatus: error.upstreamStatus } : {}),
        });
      }
      throw error;
    }
  }

  /** The values the stale check compares: what this change reads, and who the record is. */
  private beforeDigestOf(resolved: Resolved, before: unknown): string | null {
    if (before === undefined) return null;
    if (before === null) return digest({ exists: false });
    const { target, entity } = resolved;
    const picked: Record<string, unknown> = {};
    for (const field of target.fields) {
      if (field.readFrom) picked[field.readFrom] = readField(before, field.readFrom) ?? null;
    }
    for (const path of [entity.identity?.field, ...(entity.display?.title ?? []), entity.display?.status]) {
      if (path) picked[path] = readField(before, path) ?? null;
    }
    return digest({ exists: true, picked });
  }

  private recordName(entity: EntitySpec, before: unknown): string | undefined {
    if (!before || typeof before !== "object") return undefined;
    const parts = (entity.display?.title ?? [])
      .map((path) => readField(before, path))
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map(String);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }

  /* ── step one ─────────────────────────────────────────────────────── */

  /** What identifies one requested change, whatever order its values came in. */
  intentDigest(intent: WriteIntent): string {
    return digest({
      connection: intent.connection,
      entity: intent.entity,
      kind: intent.kind,
      action: intent.action ?? null,
      id: intent.id ?? null,
      parents: intent.parents ?? {},
      values: intent.values ?? {},
    });
  }

  /**
   * The values a form opens with: each request field's current value, read
   * from the record as it is now. For a create there is nothing to read; for
   * a record that exists once under its parent, `exists` says whether it is
   * there yet — which is the difference between "Add" and "Edit".
   */
  async current(
    principal: WriteActor,
    intent: WriteIntent,
  ): Promise<{ readonly values: Record<string, unknown>; readonly exists: boolean; readonly target: WriteTarget }> {
    const resolved = await this.resolve(principal, intent);
    const { target } = resolved;
    if (intent.kind === "create" && target.mode !== "upsert") return { values: {}, exists: false, target };
    const params = this.addressOf(resolved, intent);
    const before = await this.readBefore(resolved, params, intent);
    const values: Record<string, unknown> = {};
    if (before && typeof before === "object") {
      for (const field of settable(target.fields)) {
        const value = currentValue(field, before);
        if (value !== undefined) values[field.path] = value;
      }
    }
    return { values, exists: before !== null && before !== undefined, target };
  }

  /** A pending change of this principal's, unspent and unexpired. */
  pendingFor(principal: WriteActor, pendingId: string): PendingWrite | undefined {
    const pending = this.pending.get(pendingId);
    return pending && pending.userId === principal.userId && !pending.consumed ? pending : undefined;
  }

  /**
   * Build the change and hand back what the person will say yes to.
   *
   * For the assistant, the same intent asked again in the same conversation
   * returns the review already made, without reading the record again.
   */
  async prepare(
    principal: WriteActor,
    intent: WriteIntent,
    options: { readonly via: WriteVia; readonly sessionId?: string; readonly onBehalfOf?: WriteOnBehalfOf } = { via: "form" },
  ): Promise<WriteReview> {
    const intentDigest = this.intentDigest(intent);
    if (options.via === "chat") {
      const reused = this.pending.reusable(principal.userId, options.sessionId, intentDigest);
      if (reused) return reused.review;
    }

    let resolved: Resolved;
    try {
      resolved = await this.resolve(principal, intent);
    } catch (error) {
      if (error instanceof WriteError) this.refused(principal, intent, options.via, error, undefined, options.onBehalfOf);
      throw error;
    }
    const { connection, entity, target } = resolved;
    // From here on, the record type by its own id, however it was named.
    intent = { ...intent, entity: entity.id };
    const params = this.addressOf(resolved, intent);

    // A plain create has no record yet, so nothing to read and nothing to go stale.
    const needsBefore = intent.kind !== "create" || target.mode === "upsert";
    const before = needsBefore ? await this.readBefore(resolved, params, intent) : undefined;

    const effectiveMode: PendingWrite["effectiveMode"] =
      target.mode === "upsert"
        ? before
          ? "replace"
          : "create"
        : target.mode === "create" || target.mode === "replace" || target.mode === "merge"
          ? target.mode
          : target.mode === "delete"
            ? "delete"
            : "action";

    if (effectiveMode === "replace" && (before === null || before === undefined)) {
      // A replace sends the whole record; without the record there is nothing safe to send.
      throw new WriteError(
        404,
        "not-found",
        `That ${entity.name.one.toLowerCase()} could not be read from ${connection.title}, so it cannot be changed safely.`,
      );
    }

    const built = buildBody({
      target,
      values: intent.values ?? {},
      before,
      mode: effectiveMode === "delete" || effectiveMode === "action" ? "merge" : effectiveMode,
    });
    if (built.errors.length > 0) {
      throw new WriteError(422, "invalid", `Some of the values cannot be sent: ${built.errors.map((error) => `${error.label} ${error.message}`).join("; ")}.`, {
        fields: built.errors,
      });
    }
    if (intent.kind === "update" && !built.rows.some((row) => row.changed)) {
      throw new WriteError(422, "invalid", "Nothing would change — no value differs from what is there now.");
    }
    if (intent.kind === "action" && settable(target.fields).some((field) => field.required) && !built.body) {
      throw new WriteError(422, "invalid", `"${target.title}" needs values before it can run.`);
    }

    const beforeDigest = this.beforeDigestOf(resolved, before);
    const record = this.recordName(entity, before);
    const warnings: string[] = [];
    if (built.notSent.length > 0) {
      warnings.push(
        `Not sent: ${built.notSent.join(", ")}. Their current values could not be read, and ${connection.title} replaces the whole record — they may be cleared.`,
      );
    }
    if (!target.verified) warnings.push(`This is the first time "${target.title}" is being used from here.`);
    if (target.confidence === "inferred") warnings.push("This endpoint was read from documentation prose, not from a specification.");

    const danger = intent.kind === "delete" || Boolean(target.action?.danger);
    const named = record ? ` “${record}”` : "";
    const changedCount = built.rows.filter((row) => row.changed).length;
    const summary =
      effectiveMode === "create"
        ? `Create a new ${entity.name.one.toLowerCase()} on ${connection.title}.`
        : intent.kind === "update"
          ? `Change ${changedCount} value${changedCount === 1 ? "" : "s"} on ${entity.name.one.toLowerCase()}${named} on ${connection.title}.`
          : intent.kind === "delete"
            ? `Delete ${entity.name.one.toLowerCase()}${named} from ${connection.title}. This cannot be undone here.`
            : `${target.title}: ${entity.name.one.toLowerCase()}${named} on ${connection.title}.`;

    const now = this.now();
    const id = this.pending.newId();
    const request = {
      method: target.method,
      path: target.path.replace(/\{\{\s*param\.([A-Za-z0-9_]+)[^}]*\}\}/g, (_token, name: string) => params[name] ?? ""),
      body: built.body ?? null,
    };
    const requestDigest = digest({ id, request, beforeDigest });
    const review: WriteReview = {
      pendingId: id,
      digest: requestDigest,
      connection: connection.id,
      connectionTitle: connection.title,
      entity: entity.id,
      entityName: entity.name.one,
      kind: intent.kind,
      mode: target.mode === "upsert" ? `upsert:${effectiveMode === "create" ? "create" : "update"}` : target.mode,
      title: target.title,
      summary,
      ...(record ? { record } : {}),
      rows: built.rows,
      warnings,
      danger,
      unverified: !target.verified,
      inferred: target.confidence === "inferred",
      expiresAt: new Date(now + PENDING_TTL_MS).toISOString(),
    };
    this.pending.put({
      id,
      userId: principal.userId,
      workspaceId: principal.workspaceId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      intentDigest,
      intent,
      via: options.via,
      ...(options.onBehalfOf ? { onBehalfOf: options.onBehalfOf } : {}),
      target,
      params,
      body: built.body,
      before,
      beforeDigest,
      effectiveMode,
      digest: requestDigest,
      review,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      consumed: false,
    });
    return review;
  }

  /** The review for a pending change, for whoever prepared it. */
  review(principal: WriteActor, pendingId: string): WriteReview {
    const pending = this.pending.get(pendingId);
    if (!pending) throw new WriteError(404, "expired", "This review has expired. Ask for the change again.");
    if (pending.userId !== principal.userId) throw new WriteError(403, "not-yours", "This review belongs to somebody else.");
    return pending.review;
  }

  discard(principal: WriteActor, pendingId: string): void {
    const pending = this.pending.get(pendingId);
    if (pending && pending.userId === principal.userId) this.pending.discard(pendingId);
  }

  /* ── step two ─────────────────────────────────────────────────────── */

  /**
   * Send a reviewed change, once, if it is still the change that was reviewed.
   */
  async commit(principal: WriteActor, pendingId: string, approvedDigest: string): Promise<CommitResult> {
    const pending = this.pending.get(pendingId);
    if (!pending) throw new WriteError(404, "expired", "This review has expired. Ask for the change again.");
    if (pending.userId !== principal.userId) throw new WriteError(403, "not-yours", "This review belongs to somebody else.");
    if (pending.consumed) throw new WriteError(409, "already-sent", "This change has already been sent.");
    if (pending.digest !== approvedDigest) {
      throw new WriteError(409, "digest-mismatch", "What was approved is not what would be sent. Review the change again.");
    }

    // Everything is asked again: access and permission can have changed while the review was open.
    let resolved: Resolved;
    try {
      resolved = await this.resolve(principal, pending.intent);
    } catch (error) {
      if (error instanceof WriteError) this.refused(principal, pending.intent, pending.via, error, pending, pending.onBehalfOf);
      throw error;
    }
    if (resolved.target.op !== pending.target.op) {
      throw new WriteError(409, "stale", "How this change is sent has changed since it was reviewed. Review it again.");
    }
    pending.consumed = true;

    // Nobody else has changed the record since the review?
    if (pending.beforeDigest !== null) {
      let now: unknown;
      try {
        now = await this.readBefore(resolved, pending.params, pending.intent);
      } catch (error) {
        pending.consumed = false;
        throw error;
      }
      if (this.beforeDigestOf(resolved, now) !== pending.beforeDigest) {
        this.pending.discard(pending.id);
        const fresh = await this.prepare(principal, pending.intent, {
          via: pending.via,
          ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
          ...(pending.onBehalfOf ? { onBehalfOf: pending.onBehalfOf } : {}),
        }).catch(() => undefined);
        this.record(principal, pending, resolved, { status: "refused", error: "changed since it was reviewed" });
        throw new WriteError(
          409,
          "stale",
          `This ${resolved.entity.name.one.toLowerCase()} changed on ${resolved.connection.title} after the review. Look at it again before sending.`,
          fresh ? { review: fresh } : {},
        );
      }
    }

    const { connection, entity, target, entry } = resolved;
    const writeOp = entry.writes.find((op) => op.id === target.op) as WriteOpDef;
    const scope = scopeOpAuth(entry, connection);
    let dispatched = false;
    let answer: Awaited<ReturnType<RestAdapter["write"]>>;
    try {
      answer = await this.deps.upstream(
        connection.id,
        async () => {
          dispatched = true;
          return this.deps.rest.write(
            connection,
            {
              op: {
                id: writeOp.id,
                title: writeOp.title,
                method: writeOp.method,
                path: writeOp.path,
                query: writeOp.query,
                headers: { ...(connection.dialect?.headers ?? {}), ...writeOp.headers },
                ...(writeOp.auth ? { auth: scope(writeOp.auth) } : {}),
                ...(writeOp.authRequired !== undefined ? { authRequired: writeOp.authRequired } : {}),
              },
              params: pending.params,
              ...(pending.body !== undefined ? { body: pending.body } : {}),
              ...(writeOp.body?.contentType ? { contentType: writeOp.body.contentType } : {}),
            },
            { now: this.now(), resolveSecret: async (keyRef) => (await this.deps.keys.get(keyRef)) ?? null },
          );
        },
        Priority.Interactive,
      );
    } catch (error) {
      const notSent = !dispatched || (error instanceof AdapterError && error.outcome === "not-sent");
      // Nothing left this machine, so the same yes can be used again.
      if (notSent) pending.consumed = false;
      if (dispatched) this.deps.queries.accounting.wrote(connection.id, this.now());
      const adapter = error instanceof AdapterError ? error : undefined;
      const outcome = notSent ? "not-sent" : adapter?.outcome;
      this.record(principal, pending, resolved, {
        status: outcome === "unknown" ? "unknown" : "failed",
        error: adapter?.detail ?? adapter?.userMessage ?? String(error),
        ...(adapter?.upstreamStatus !== undefined ? { upstreamStatus: adapter.upstreamStatus } : {}),
      });
      // It may have happened: whatever was cached about this record may be wrong now.
      if (outcome === "unknown") this.invalidate(resolved);
      throw new WriteError(adapter?.status === 429 ? 429 : adapter?.status === 504 ? 504 : 502, "upstream", adapter?.userMessage ?? "The change could not be sent.", {
        ...(adapter?.detail ? { detail: adapter.detail } : {}),
        ...(adapter?.upstreamStatus !== undefined ? { upstreamStatus: adapter.upstreamStatus } : {}),
        ...(outcome ? { outcome } : {}),
      });
    }
    this.deps.queries.accounting.wrote(connection.id, this.now());

    const key = this.keyAfter(resolved, pending, answer);
    const ops = this.invalidate(resolved);
    this.deps.seen.touch(connection.id, this.now());
    this.markVerified(entry, target.op);
    const changed = pending.review.rows.filter((row) => row.changed).map((row) => row.label);
    const reversal = this.reversalOf(resolved, pending, key);
    this.record(principal, pending, resolved, {
      status: "succeeded",
      upstreamStatus: answer.status,
      after: answer.body,
      ...(key ? { key } : {}),
    });
    this.pending.discard(pending.id);
    return {
      status: "succeeded",
      connection: connection.id,
      entity: entity.id,
      kind: pending.intent.kind,
      ...(key ? { key } : {}),
      ...(answer.body !== null && answer.body !== undefined ? { record: answer.body } : {}),
      changed,
      invalidated: { connection: connection.id, ops },
      title: target.title,
      eventId: pending.id,
      ...(reversal ? { reversal } : {}),
    };
  }

  /** Who the record is after the change: the new one's id for a create, the same one otherwise. */
  private keyAfter(
    resolved: Resolved,
    pending: PendingWrite,
    answer: { readonly body: unknown; readonly location: string | null },
  ): CommitResult["key"] {
    const parents = pending.intent.parents;
    if (pending.intent.kind !== "create" || resolved.target.mode === "upsert") {
      return {
        ...(pending.intent.id ? { id: pending.intent.id } : {}),
        ...(parents ? { parents } : {}),
      };
    }
    const identity = resolved.entity.identity?.field;
    const fromBody = identity ? readField(answer.body, identity) : undefined;
    const fromLocation = answer.location?.split("?")[0]?.split("/").filter(Boolean).pop();
    const id =
      typeof fromBody === "string" || typeof fromBody === "number"
        ? String(fromBody)
        : typeof answer.body === "number" || typeof answer.body === "string"
          ? String(answer.body)
          : fromLocation;
    return id ? { id, ...(parents ? { parents } : {}) } : undefined;
  }

  /**
   * Drop the answers this change made stale: this record type's list and
   * one-record endpoints, and those of what it lives under, whose pages show
   * it. Nothing else — see `QueryCache.invalidateOps`.
   */
  private invalidate(resolved: Resolved): string[] {
    const { connection, resource, target, entry } = resolved;
    const ops = new Set<string>();
    if (resource.listOp) ops.add(resource.listOp);
    if (resource.detailOp) ops.add(resource.detailOp);
    for (const part of target.parents) {
      const parent = part.entity ? entityById(entry.entities, part.entity) : undefined;
      const parentResource = parent ? connection.resources.find((one) => one.id === parent.resource) : undefined;
      if (parentResource?.listOp) ops.add(parentResource.listOp);
      if (parentResource?.detailOp) ops.add(parentResource.detailOp);
    }
    const list = [...ops];
    this.deps.queries.invalidateOps(connection.id, list);
    return list;
  }

  /** The first real success through an endpoint is what makes it verified. */
  private markVerified(entry: CatalogEntry, opId: string): void {
    const catalog = this.deps.catalog;
    if (!catalog) return;
    const op = entry.writes.find((one) => one.id === opId);
    if (!op || op.verified) return;
    try {
      catalog.put({
        ...entry,
        writes: entry.writes.map((one) => (one.id === opId ? { ...one, verified: true } : one)),
      });
    } catch {
      // A catalog that cannot be written costs a badge, never the change that already happened.
    }
  }

  /* ── the journal ──────────────────────────────────────────────────── */

  private reversalOf(resolved: Resolved, pending: PendingWrite, key: CommitResult["key"]): WriteReversal | undefined {
    const { target, graph, entity } = resolved;
    const writes = graph.writesOf(entity.id);
    if (pending.intent.kind === "update" && pending.before) {
      const values: Record<string, unknown> = {};
      for (const row of pending.review.rows) {
        if (!row.changed) continue;
        const field = target.fields.find((one) => one.path === row.field);
        if (field) values[field.path] = currentValue(field, pending.before) ?? null;
      }
      return { kind: "update", values };
    }
    if (pending.intent.kind === "create" && pending.effectiveMode === "create" && writes.remove && key) {
      return { kind: "delete", key };
    }
    if (pending.intent.kind === "delete" && pending.before && writes.create) {
      const values: Record<string, unknown> = {};
      for (const field of settable(writes.create.fields)) {
        const value = currentValue(field, pending.before);
        if (value !== undefined && value !== null) values[field.path] = value;
      }
      return { kind: "create", values };
    }
    if (pending.intent.kind === "action" && target.action?.pairedWith) {
      return { kind: "action", action: target.action.pairedWith };
    }
    return undefined;
  }

  private record(
    principal: WriteActor,
    pending: PendingWrite,
    resolved: Resolved,
    outcome: {
      status: WriteEvent["status"];
      error?: string;
      upstreamStatus?: number;
      after?: unknown;
      key?: CommitResult["key"];
    },
  ): void {
    const key = outcome.key ?? {
      ...(pending.intent.id ? { id: pending.intent.id } : {}),
      ...(pending.intent.parents ? { parents: pending.intent.parents } : {}),
    };
    const reversal = outcome.status === "succeeded" ? this.reversalOf(resolved, pending, key) : undefined;
    const event: WriteEvent = {
      id: pending.id,
      at: new Date(this.now()).toISOString(),
      actor: { userId: principal.userId, workspaceId: principal.workspaceId },
      via: pending.via,
      ...(pending.onBehalfOf ? { onBehalfOf: pending.onBehalfOf } : {}),
      connection: resolved.connection.id,
      entity: resolved.entity.id,
      key,
      kind: pending.intent.kind,
      ...(pending.intent.action ? { action: pending.intent.action } : {}),
      opId: pending.target.op,
      method: pending.target.method,
      path: pending.target.path.replace(/\{\{\s*param\.([A-Za-z0-9_]+)[^}]*\}\}/g, (_t, name: string) => pending.params[name] ?? ""),
      ...(pending.before !== undefined ? { before: pending.before } : {}),
      ...(pending.body !== undefined ? { sent: pending.body } : {}),
      ...(outcome.after !== undefined ? { after: outcome.after } : {}),
      changed: pending.review.rows.filter((row) => row.changed).map((row) => row.label),
      status: outcome.status,
      ...(outcome.upstreamStatus !== undefined ? { upstreamStatus: outcome.upstreamStatus } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(reversal ? { reversal } : {}),
    };
    this.emit(event);
  }

  /** A change refused before anything was prepared: journalled too, with nothing to reverse. */
  private refused(
    principal: WriteActor,
    intent: WriteIntent,
    via: WriteVia,
    error: WriteError,
    pending?: PendingWrite,
    onBehalfOf?: WriteOnBehalfOf,
  ): void {
    if (error.code === "not-found") return;
    this.emit({
      id: pending?.id ?? this.pending.newId(),
      at: new Date(this.now()).toISOString(),
      actor: { userId: principal.userId, workspaceId: principal.workspaceId },
      via,
      ...(onBehalfOf ? { onBehalfOf } : {}),
      connection: intent.connection,
      entity: intent.entity,
      key: { ...(intent.id ? { id: intent.id } : {}), ...(intent.parents ? { parents: intent.parents } : {}) },
      kind: intent.kind,
      ...(intent.action ? { action: intent.action } : {}),
      opId: pending?.target.op ?? "",
      method: pending?.target.method ?? "",
      path: "",
      changed: [],
      status: "refused",
      error: `${error.code}: ${error.message}`,
    });
  }

  private emit(event: WriteEvent): void {
    try {
      const result = this.deps.journal.record(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // A journal that fails must never undo or block a change that already happened.
    }
  }
}

/**
 * The fields of a target, for describing what a record type accepts.
 *
 * A form gets every option — one API's country list is two hundred and fifty
 * long, and a picker missing the one somebody needs is a form they cannot
 * fill in. The assistant gets the first few, where the whole list would only
 * be tokens: `maxOptions`.
 */
export const describeFields = (target: WriteTarget, options: { readonly maxOptions?: number } = {}) =>
  settable(target.fields).map((field) => ({
    field: field.path,
    label: labelOf(field),
    type: field.type,
    required: field.required,
    ...(field.format ? { format: field.format } : {}),
    ...(field.enum
      ? { options: options.maxOptions === undefined ? field.enum : field.enum.slice(0, options.maxOptions) }
      : {}),
    ...(field.reference ? { references: field.reference.entity } : {}),
    ...(field.readFrom !== undefined ? { readFrom: field.readFrom } : {}),
  }));
