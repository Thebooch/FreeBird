import { randomUUID } from "node:crypto";
import type { LlmAdapter, StarterCheck } from "@freebirdai/dash-agent";
import {
  briefCandidates,
  categoriseApi,
  categoryFingerprint,
  classifyRhythm,
  composeCategory,
  inferShape,
} from "@freebirdai/dash-agent";
import { AdapterError } from "@freebirdai/dash-adapters";
import { compilePlan, executeWidget, runPipeline } from "@freebirdai/dash-runtime";
import type {
  CatalogEntry,
  CategorySpec,
  ConnectionSpec,
  DashboardSpec,
  EntitySpec,
  OnboardingPreview,
  OnboardingSpec,
  ResolvedParams,
  WidgetCheck,
  WidgetCheckStatus,
  WidgetSpec,
} from "@freebirdai/dash-spec";
import {
  CATEGORY_VERSION,
  dashboardSchema,
  fingerprintConnection,
  fnv1a,
  getOp,
  interpolateValue,
  missingInputs,
  onboardingChoicesSchema,
  onboardingSchema,
  opDefSchema,
  widgetSources,
} from "@freebirdai/dash-spec";
import type { CatalogStore } from "../catalog.js";
import { hasRhythm, mergeApiRhythm } from "../keeper/rhythm.js";
import { boardParams } from "../keeper/targets.js";
import { allocateDashboardId, buildCategory, packBoards, type Built } from "./materialise.js";

/**
 * Asking somebody what they want from a connection, and giving it to them.
 *
 * Two artifacts with two lifetimes, and the split is the whole architecture:
 *
 * - **The catalog entry** says how the API divides up and what each part
 *   opens with. It describes the API, costs model tokens and **zero requests
 *   against anybody's account**, and is inherited by everybody who connects
 *   this API afterwards. Prepared one step at a time — divide, compose a
 *   part, read how often records arrive — each written as soon as it lands,
 *   so a run that dies keeps everything before it and the next picks up
 *   where it stopped.
 * - **The connection's setup** records one person's way through it: which
 *   parts they picked, the preview they looked at, the boards that came of
 *   it. A state machine, so every step can be left and come back to.
 *
 * The flow — prepare in steps, choose, preview against the account, create —
 * came from a parallel implementation that got resumption right. The data
 * model stayed: starters are briefs, never widgets, so nothing that names one
 * account's endpoints ever reaches the shared half; and the packer lays out
 * every board, so no model ever writes a rectangle.
 */

type Values = Readonly<Record<string, string | number | boolean>>;

/** A refusal worth a sentence and a status, rather than a 500. */
export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly detail?: readonly string[],
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export interface OnboardingDeps {
  readonly catalog: CatalogStore | undefined;
  /** Null when no AI key is configured. */
  readonly llm: () => LlmAdapter | null;
  readonly getConnection: (id: string) => ConnectionSpec | null;
  readonly putConnection: (spec: ConnectionSpec) => void;
  readonly getDashboard: (id: string) => DashboardSpec | null;
  readonly putDashboard: (spec: DashboardSpec) => void;
  /** Every board id in use, so reservations do not collide. */
  readonly dashboardIds: () => readonly string[];
  /**
   * Read one endpoint through the query cache, exactly as a board would.
   *
   * Resolves to the body. Throws an `AdapterError` when the API refused —
   * including when a cached copy was served in place of a refusal, because
   * checking a widget is asking whether it works *now*.
   */
  readonly read: (input: {
    readonly connection: ConnectionSpec;
    readonly op: string;
    readonly params: Values;
    readonly resolved: ResolvedParams;
  }) => Promise<unknown>;
  /**
   * Give a connection somebody declined to set up the plain board it would
   * have had before onboarding existed, so there is somewhere to land.
   */
  readonly ensureDefaultBoard?: ((connection: ConnectionSpec) => void) | undefined;
  /**
   * Whether this API's record types are being described at this moment.
   *
   * Dividing an API while its record types are still arriving would divide
   * the ones that happened to be done, and the rest landing afterwards would
   * make that division stale — to be paid for a second time.
   */
  readonly isDescribing?: ((catalogId: string) => boolean) | undefined;
  readonly onChanged?: (() => void) | undefined;
  readonly now?: (() => number) | undefined;
}

/* ── the shared half ──────────────────────────────────────────────────── */

/** The reading of an API its categories would be made against now. */
export const currentFingerprint = (entry: CatalogEntry): string =>
  categoryFingerprint({
    entities: entry.entities ?? [],
    resources: entry.resources,
    ops: entry.ops,
  });

/** Whether the rhythm on record was read against this reading of the API. */
const rhythmCurrent = (entry: CatalogEntry, fingerprint: string): boolean =>
  entry.rhythm !== undefined &&
  (entry.rhythm.fingerprint === undefined ? hasRhythm(entry) : entry.rhythm.fingerprint === fingerprint);

export interface CategoryState {
  readonly divided: boolean;
  /** Divided against an older reading of the API, or an older pass. */
  readonly stale: boolean;
  readonly categories: number;
  /** Categories with a starting dashboard. */
  readonly composed: number;
  readonly pending: number;
  readonly empty: number;
  readonly failed: number;
  readonly starters: number;
  readonly entities: number;
  /** Whether how often each record type gains rows has been read. */
  readonly rhythm: boolean;
  /** Steps of preparation left, counting a failed part as one. */
  readonly remaining: number;
  readonly categoriesAt: string | null;
}

/** What is known about an API's divisions, read off the stored entry. */
export const categoryState = (entry: CatalogEntry): CategoryState => {
  const categories = entry.categories ?? [];
  const count = (status: CategorySpec["status"]): number =>
    categories.filter((category) => category.status === status).length;
  const fingerprint = currentFingerprint(entry);
  const divided = categories.length > 0;
  const stale =
    divided &&
    ((entry.categoryVersion !== undefined && entry.categoryVersion < CATEGORY_VERSION) ||
      (entry.categoryFingerprint !== undefined && entry.categoryFingerprint !== fingerprint));
  const rhythm = rhythmCurrent(entry, fingerprint);
  const pending = count("pending");
  const failed = count("failed");
  return {
    divided,
    stale,
    categories: categories.length,
    composed: count("ready"),
    pending,
    empty: count("empty"),
    failed,
    starters: categories.reduce((sum, category) => sum + category.starters.length, 0),
    entities: (entry.entities ?? []).length,
    rhythm,
    remaining:
      !divided || stale
        ? 1 + (rhythm ? 0 : 1)
        : pending + failed + ((entry.entities ?? []).length > 0 && !rhythm ? 1 : 0),
    categoriesAt: entry.categoriesAt ?? null,
  };
};

/** Endpoints behind each record type, so a category can say what it covers. */
const endpointCountsFor = (entry: CatalogEntry): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const resource of entry.resources) {
    counts[resource.id] = new Set(
      [resource.listOp, resource.detailOp].filter((op): op is string => Boolean(op)),
    ).size;
  }
  return counts;
};

/**
 * A category as it applies to one connection.
 *
 * The catalog describes the whole API; a connection holds whichever endpoints
 * somebody picked. A category none of whose record types this connection can
 * read is reported unavailable rather than offered — an offer that cannot be
 * executed is the failure this whole area keeps circling back to.
 */
export interface CategoryOffer {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: CategorySpec["status"];
  readonly recordTypes: number;
  readonly endpoints: number;
  readonly widgets: number;
  /** What it opens with, in a reader's words, so the choice is not blind. */
  readonly opensWith: readonly string[];
  readonly available: boolean;
  readonly unavailable?: string | undefined;
}

export const offersFor = (input: {
  readonly connection: ConnectionSpec;
  readonly entry: CatalogEntry;
}): readonly CategoryOffer[] => {
  const entities = input.entry.entities ?? [];
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const ops = new Set(input.connection.ops.map((op) => op.id));
  const counts = endpointCountsFor(input.entry);

  /** A record type this connection can actually read rows of. */
  const readable = (entity: EntitySpec | undefined): boolean => {
    if (!entity) return false;
    const resource = input.connection.resources.find((one) => one.id === entity.resource);
    return resource?.listOp !== undefined && ops.has(resource.listOp);
  };

  return (input.entry.categories ?? []).map((category) => {
    const mine = category.entities.filter((id) => readable(byId.get(id)));
    const endpoints = category.entities.reduce((sum, id) => {
      const resource = byId.get(id)?.resource ?? id;
      return sum + (counts[resource] ?? 0);
    }, 0);
    const buildable = category.starters.filter((starter) =>
      mine.includes(starter.brief.entity),
    );
    const unavailable =
      buildable.length > 0
        ? undefined
        : category.status === "pending"
          ? "Not prepared yet."
          : category.status === "failed"
            ? (category.error ?? "Preparing this part failed. Retry to finish it.")
            : category.status === "empty"
              ? "Nothing in this part could be built from what this API offers."
              : mine.length === 0
                ? "This connection does not carry the endpoints behind these records."
                : "None of its widgets are about records this connection carries.";
    return {
      id: category.id,
      title: category.title,
      ...(category.description ? { description: category.description } : {}),
      status: category.status,
      recordTypes: mine.length,
      endpoints,
      widgets: buildable.length,
      opensWith: buildable
        .map(
          (starter) =>
            starter.brief.title ?? byId.get(starter.brief.entity)?.name.many ?? starter.brief.entity,
        )
        .slice(0, 8),
      available: buildable.length > 0,
      ...(unavailable ? { unavailable } : {}),
    };
  });
};

/** What one step of preparation did. */
export interface PrepareStep {
  readonly step: "divided" | "composed" | "rhythm" | "none";
  /** False when the step failed; the client stops its loop and offers a retry. */
  readonly ok: boolean;
  /** The category composed, for `composed`. */
  readonly category?: string | undefined;
  readonly error?: string | undefined;
  /** Where the pass declined something, in a reader's words. */
  readonly skipped: readonly string[];
  readonly proposed: number;
  readonly kept: number;
  readonly uncategorised: readonly string[];
}

/* ── the personal half ────────────────────────────────────────────────── */

/** A widget's check, before it is attached to a board. */
interface Checked {
  readonly built: Built;
  readonly status: WidgetCheckStatus;
  readonly message: string;
}

/** How many distinct reads one preview may make against somebody's API. */
export const PREVIEW_READ_BUDGET = 40;

/** A board as the setup screen lists it. */
export interface SetupBoard {
  readonly dashboard: string;
  readonly title: string;
  readonly widgets: number;
  readonly category?: string | undefined;
}

export interface OnboardingStatusView {
  readonly connection: string;
  readonly title: string;
  readonly catalog: string | null;
  readonly profile?: CatalogEntry["profile"];
  /** Null when there is no integration to set up from. */
  readonly state:
    | (CategoryState & { readonly canRun: boolean; readonly describing: boolean })
    | null;
  /** Why setup cannot go further right now, when it cannot. */
  readonly reason?: string | undefined;
  readonly categories: readonly CategoryOffer[];
  readonly setup: OnboardingSpec;
  /** The boards the latest set made that still exist. */
  readonly boards: readonly SetupBoard[];
}

const NOT_STARTED: OnboardingSpec = onboardingSchema.parse({ status: "pending" });

export class OnboardingService {
  private readonly locks = new Set<string>();

  constructor(private readonly deps: OnboardingDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private connection(id: string): ConnectionSpec {
    const connection = this.deps.getConnection(id);
    if (!connection) throw new OnboardingError("No such connection.", 404);
    return connection;
  }

  private entryFor(connection: ConnectionSpec): CatalogEntry | undefined {
    return (connection.catalog ? this.deps.catalog?.get(connection.catalog) : undefined) ?? undefined;
  }

  private requireEntry(connection: ConnectionSpec): CatalogEntry {
    const entry = this.entryFor(connection);
    if (!entry) {
      throw new OnboardingError(
        "This connection has no integration behind it to set up from. Map and describe its records first.",
      );
    }
    return entry;
  }

  private setupOf(connection: ConnectionSpec): OnboardingSpec {
    return connection.onboarding ?? NOT_STARTED;
  }

  /** Write the connection's setup, over the latest copy of the connection. */
  private save(id: string, patch: Partial<OnboardingSpec>): OnboardingSpec {
    const current = this.connection(id);
    const next = onboardingSchema.parse({ ...this.setupOf(current), ...patch });
    this.deps.putConnection({ ...current, onboarding: next });
    return next;
  }

  /**
   * One run at a time, per API for preparing and per connection for the rest.
   *
   * Two tabs pressing the same button would otherwise pay for every model
   * call twice and interleave their writes.
   */
  private async locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.locks.has(key)) {
      throw new OnboardingError("This is already being worked on. Check back in a moment.");
    }
    this.locks.add(key);
    try {
      return await run();
    } finally {
      this.locks.delete(key);
    }
  }

  status(id: string): OnboardingStatusView {
    const connection = this.connection(id);
    const entry = this.entryFor(connection);
    const setup = this.setupOf(connection);
    const canRun = this.deps.llm() !== null;
    const describing = entry ? (this.deps.isDescribing?.(entry.id) ?? false) : false;
    const state = entry ? { ...categoryState(entry), canRun, describing } : null;

    const reason = !entry
      ? "This connection has no integration behind it to set up from."
      : describing
        ? `Still working out what this API's record types are — ${state!.entities} so far. Setting up dashboards starts as soon as that finishes.`
        : state!.entities === 0
        ? "This API's records have not been described yet. Describe them in Records first."
        : state!.remaining > 0 && !canRun
          ? "Preparing dashboards needs an AI key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY on the server."
          : undefined;

    /*
     * A board deleted since is not a board. Reported as gone rather than
     * linked to, so "already set up" never points at nothing.
     */
    const boards = setup.dashboards.flatMap((dashboard) => {
      const found = this.deps.getDashboard(dashboard);
      const planned = setup.preview?.boards.find((one) => one.board.id === dashboard);
      return found
        ? [
            {
              dashboard,
              title: found.title,
              widgets: found.widgets.length,
              ...(planned?.category ? { category: planned.category } : {}),
            },
          ]
        : [];
    });

    return {
      connection: connection.id,
      title: connection.title,
      catalog: connection.catalog ?? null,
      ...(entry?.profile ? { profile: entry.profile } : {}),
      state,
      ...(reason ? { reason } : {}),
      categories: entry ? offersFor({ connection, entry }) : [],
      setup,
      boards,
    };
  }

  /**
   * One step of preparing an API's starting dashboards. Called until there is
   * nothing left, one request per step, so no request is long and every step
   * is written as soon as it lands.
   *
   * In order: divide the API when it has not been or the API has changed
   * since; compose each part not yet composed; read how often its records
   * arrive; then retry any part that failed. Costs model tokens and zero
   * requests against anybody's API.
   */
  async prepareEntry(entryId: string): Promise<PrepareStep> {
    const catalog = this.deps.catalog;
    if (!catalog) throw new OnboardingError("No catalog is configured.", 501);

    return this.locked(`integration:${entryId}`, async () => {
      const entry = catalog.get(entryId);
      if (!entry) throw new OnboardingError("No such integration.", 404);
      if (this.deps.isDescribing?.(entryId)) {
        throw new OnboardingError(
          "This API's record types are still being described. Setting up dashboards starts once that finishes.",
        );
      }
      const entities = entry.entities ?? [];
      if (entities.length === 0) {
        throw new OnboardingError(
          "This API's records have not been described yet, so there is nothing to divide up.",
        );
      }

      const state = categoryState(entry);
      const fingerprint = currentFingerprint(entry);
      const none: PrepareStep = {
        step: "none",
        ok: true,
        skipped: [],
        proposed: 0,
        kept: 0,
        uncategorised: [],
      };
      if (state.remaining === 0) {
        /* An entry divided before fingerprints existed is current; say so. */
        if (entry.categoryFingerprint === undefined) {
          catalog.put({ ...entry, categoryFingerprint: fingerprint, categoryVersion: CATEGORY_VERSION });
        }
        return none;
      }

      const llm = this.deps.llm();
      if (!llm) {
        throw new OnboardingError(
          "Planning a connection's dashboards needs an AI key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY on the server.",
          400,
        );
      }

      const candidates = briefCandidates([{ connection: entry.id, title: entry.title, entities }]);

      /*
       * Never publish work done against an API that changed during the call:
       * it would be shared with everybody as a reading of an API that no
       * longer exists.
       */
      const latest = (): CatalogEntry => {
        const now = catalog.get(entryId);
        if (!now || currentFingerprint(now) !== fingerprint) {
          throw new OnboardingError(
            "This API was re-described while its dashboards were being prepared. Run it again.",
          );
        }
        return now;
      };

      /* 1. Divide. Re-dividing re-ids every part, so only when it must. */
      if (!state.divided || state.stale) {
        const divided = await categoriseApi(llm, {
          apiTitle: entry.title,
          candidates,
          endpointCounts: endpointCountsFor(entry),
        });
        if (divided.categories.length === 0) {
          throw new OnboardingError(
            divided.errors[0] ?? "This API could not be divided into parts worth a dashboard.",
            502,
            divided.skipped,
          );
        }
        const current = latest();
        catalog.put({
          ...current,
          categories: divided.categories.map((category) => ({
            ...category,
            starters: [],
            status: "pending" as const,
          })),
          ...(divided.profile ? { profile: divided.profile } : {}),
          categoriesAt: new Date(this.now()).toISOString(),
          categoryVersion: CATEGORY_VERSION,
          categoryFingerprint: fingerprint,
          updatedAt: new Date(this.now()).toISOString(),
        });
        return {
          ...none,
          step: "divided",
          skipped: divided.skipped,
          uncategorised: divided.uncategorised,
        };
      }

      const check: StarterCheck = {
        entities,
        resources: entry.resources,
        ops: entry.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
        connection: entry.id,
        pathOf: (op) => entry.ops.find((one) => one.id === op)?.path,
        /* The catalog keeps ops without the defaults a def carries; parsed so
         * `missingInputs` reads them the way it reads a connection's own. */
        opDefs: entry.ops.map((op) => opDefSchema.parse(op)),
      };

      const compose = async (category: CategorySpec): Promise<PrepareStep> => {
        const result = await composeCategory(llm, {
          apiTitle: entry.title,
          category,
          candidates,
          check,
        });
        const current = latest();
        catalog.put({
          ...current,
          categories: (current.categories ?? []).map((one) =>
            one.id === category.id ? result.category : one,
          ),
          ...(current.categoryFingerprint === undefined
            ? { categoryFingerprint: fingerprint, categoryVersion: CATEGORY_VERSION }
            : {}),
          categoriesAt: new Date(this.now()).toISOString(),
          updatedAt: new Date(this.now()).toISOString(),
        });
        return {
          ...none,
          step: "composed",
          ok: result.error === undefined,
          category: category.id,
          ...(result.error ? { error: result.error } : {}),
          skipped: result.skipped,
          proposed: result.proposed,
          kept: result.category.starters.length,
        };
      };

      /* 2. The next part not yet composed. */
      const pending = (entry.categories ?? []).find((category) => category.status === "pending");
      if (pending) return compose(pending);

      /* 3. How often each record type gains rows. */
      if (!state.rhythm) {
        const rated = await classifyRhythm(llm, { apiTitle: entry.title, candidates });
        if (Object.keys(rated.rhythm).length === 0) {
          return {
            ...none,
            step: "rhythm",
            ok: false,
            error: `How often records arrive could not be read: ${rated.errors[0] ?? "no answer"}.`,
            skipped: rated.skipped,
          };
        }
        const current = latest();
        catalog.put({
          ...current,
          rhythm: mergeApiRhythm(current.rhythm, { ...rated, fingerprint }),
          updatedAt: new Date(this.now()).toISOString(),
        });
        return { ...none, step: "rhythm", skipped: rated.skipped };
      }

      /* 4. A part that failed last time. */
      const failed = (entry.categories ?? []).find((category) => category.status === "failed");
      if (failed) return compose(failed);

      return none;
    });
  }

  /** One step, for a connection: prepares the integration behind it. */
  async prepare(id: string): Promise<OnboardingStatusView & { readonly step: PrepareStep }> {
    const connection = this.connection(id);
    const entry = this.requireEntry(connection);
    const step = await this.prepareEntry(entry.id);
    return { ...this.status(id), step };
  }

  /** Record what was picked. Clears any preview: it was of something else. */
  choose(id: string, body: unknown): OnboardingStatusView {
    const connection = this.connection(id);
    const setup = this.setupOf(connection);
    if (setup.status === "creating") {
      throw new OnboardingError("Boards are being created. Finish that first, or start another set.");
    }
    const parsed = onboardingChoicesSchema.safeParse(body);
    if (!parsed.success) throw new OnboardingError("Choose at least one part to set up.", 400);
    const entry = this.requireEntry(connection);

    const offers = new Map(offersFor({ connection, entry }).map((offer) => [offer.id, offer]));
    const refused = parsed.data.categories.flatMap((category) => {
      const offer = offers.get(category);
      if (!offer) return [`"${category}" is not a part of this API.`];
      return offer.available ? [] : [`${offer.title}: ${offer.unavailable ?? "nothing could be built."}`];
    });
    if (refused.length > 0) {
      throw new OnboardingError("Some of those parts cannot be set up.", 409, refused);
    }
    if (new Set(parsed.data.categories).size !== parsed.data.categories.length) {
      throw new OnboardingError("A part was chosen twice.", 400);
    }

    this.save(id, { status: "choosing", choices: parsed.data, preview: undefined });
    return this.status(id);
  }

  /**
   * What a preview is pinned to. Anything here changing means the preview is
   * of a connection that no longer exists in that form.
   */
  private previewFingerprint(
    connection: ConnectionSpec,
    entry: CatalogEntry,
    chosen: readonly CategorySpec[],
    layout: string,
  ): string {
    return fnv1a(
      JSON.stringify({
        connection: fingerprintConnection(connection),
        resources: connection.resources.map((resource) => [resource.id, resource.listOp ?? null]),
        reading: entry.categoryFingerprint ?? currentFingerprint(entry),
        categories: chosen.map((category) => [category.id, category.starters]),
        layout,
      }),
    );
  }

  private chosenFor(
    connection: ConnectionSpec,
    entry: CatalogEntry,
  ): { chosen: CategorySpec[]; layout: "single" | "per-category" } {
    const choices = this.setupOf(connection).choices;
    if (!choices) throw new OnboardingError("Choose which parts to set up first.");
    const chosen = choices.categories
      .map((id) => (entry.categories ?? []).find((category) => category.id === id))
      .filter((category): category is CategorySpec => category !== undefined);
    if (chosen.length === 0) {
      throw new OnboardingError("None of the parts chosen exist any more. Choose again.");
    }
    return {
      chosen,
      layout: chosen.length > 1 ? choices.layout : "per-category",
    };
  }

  /**
   * Build the boards as they would be created, and try each widget against
   * this account first.
   *
   * Every read goes through the same cache and gate as a board, under the key
   * the board will read — so a preview is also the new boards' first warm-up
   * and opening them afterwards costs nothing. Bounded: at most
   * `PREVIEW_READ_BUDGET` distinct reads, and anything past that is kept on
   * the board unchecked rather than refused.
   */
  async preview(id: string): Promise<OnboardingStatusView> {
    return this.locked(`connection:${id}`, async () => {
      const connection = this.connection(id);
      const setup = this.setupOf(connection);
      if (setup.status === "creating") {
        throw new OnboardingError("Boards are being created. Finish that first, or start another set.");
      }
      const entry = this.requireEntry(connection);
      if (categoryState(entry).stale) {
        throw new OnboardingError("This API has changed since its parts were prepared. Prepare it again first.");
      }
      const { chosen, layout } = this.chosenFor(connection, entry);
      const source = { connection, entities: entry.entities ?? [] };

      /* Compile every chosen part, with widget ids unique across all of them. */
      const notes: string[] = [];
      const taken = new Set<string>();
      const compiled = chosen.map((category) => {
        const result = buildCategory({ source, category, taken });
        notes.push(...result.notes);
        return { category, built: result.built };
      });

      /* Try each widget. */
      const params = boardParams(dashboardSchema.parse({ id: "preview", title: "Preview", widgets: [] }), this.now());
      const checker = this.checker(connection, params);
      const checked: Checked[] = [];
      for (const part of compiled) {
        for (const built of part.built) {
          checked.push({ built, ...(await checker(built.widget)) });
        }
      }

      /*
       * Kept: what answered, and what could not be tried right now. A rate
       * limit is not a reason to design a widget away.
       */
      const keep = new Set(
        checked
          .filter((one) => one.status === "ready" || one.status === "unchecked")
          .map((one) => one.built.widget.id),
      );
      const reserved = new Set(this.deps.dashboardIds());
      const packed = packBoards({
        source,
        perCategory: compiled.map((part) => ({
          category: part.category,
          built: part.built.filter((built) => keep.has(built.widget.id)),
        })),
        layout,
        reserveId: (title) => {
          const reservedId = allocateDashboardId(title, reserved);
          reserved.add(reservedId);
          return reservedId;
        },
      });

      const checks: WidgetCheck[] = checked.map((one) => ({
        category: one.built.category,
        widget: one.built.widget.id,
        title: (one.built.widget.title ?? one.built.widget.id).slice(0, 200),
        status: one.status,
        message: one.message.slice(0, 600),
      }));

      const preview: OnboardingPreview = {
        id: randomUUID(),
        fingerprint: this.previewFingerprint(connection, entry, chosen, layout),
        boards: packed.boards.map((board) => ({
          ...(board.category ? { category: board.category } : {}),
          board: board.board,
        })),
        checks,
        notes: [...notes, ...packed.notes, ...packed.errors].map((note) => note.slice(0, 400)).slice(0, 60),
      };

      /* Checked against a connection that changed while it ran is not checked. */
      const after = this.connection(id);
      const afterEntry = this.requireEntry(after);
      if (
        this.previewFingerprint(after, afterEntry, this.chosenFor(after, afterEntry).chosen, layout) !==
        preview.fingerprint
      ) {
        throw new OnboardingError("The connection changed while it was being checked. Preview again.");
      }

      this.save(id, { status: "preview", preview });
      return this.status(id);
    });
  }

  /** Try one widget against the account, within the preview's budget. */
  private checker(
    connection: ConnectionSpec,
    params: ResolvedParams,
  ): (widget: WidgetSpec) => Promise<{ status: WidgetCheckStatus; message: string }> {
    const reads = new Map<string, Promise<unknown>>();
    const now = this.now();
    const read = (op: string, values: Values): Promise<unknown> => {
      const key = JSON.stringify([op, values]);
      const known = reads.get(key);
      if (known) return known;
      if (reads.size >= PREVIEW_READ_BUDGET) return Promise.reject(new BudgetSpent());
      const pending = this.deps.read({ connection, op, params: values, resolved: params });
      reads.set(key, pending);
      return pending;
    };

    return async (widget) => {
      const sources = widgetSources(widget);
      for (const source of sources) {
        const op = getOp(connection, source.op);
        if (source.connection !== connection.id || !op) {
          return { status: "unavailable", message: "It reads an endpoint this connection does not carry." };
        }
        const filled = interpolated(source.params, params);
        if (!source.fanOut && missingInputs(op, filled).length > 0) {
          return {
            status: "missingInput",
            message: `It needs ${missingInputs(op, filled).join(", ")}, which a board has no way to supply.`,
          };
        }
      }

      try {
        const plan = compilePlan(widget);
        if (!plan.ok) {
          return { status: "schema", message: "Its pipeline no longer compiles against this connection." };
        }

        const bodies: Record<string, unknown> = {};
        for (const source of sources.filter((one) => !one.fanOut)) {
          bodies[source.as] = await read(source.op, interpolated(source.params, params));
        }

        /*
         * A fan-out source reads one row of its driver at a time. Tried with
         * the first row the driver returned, which proves access to the
         * endpoint — not that every row's record is readable.
         */
        for (const source of sources.filter((one) => one.fanOut)) {
          const fan = source.fanOut!;
          const driver = plan.plan.sources.find((one) => one.as === fan.from);
          if (!driver || !(fan.from in bodies)) {
            return { status: "schema", message: "It depends on another source this check could not follow." };
          }
          const rows = runPipeline(driver.compiled, bodies[fan.from], { now, params }).rows;
          const value = rows
            .map((row) => row[fan.field])
            .find((one) => typeof one === "string" || typeof one === "number");
          if (value === undefined) {
            /* Nothing to try it with is not a reason to leave it off. */
            return { status: "unchecked", message: "There was no record yet to try it with." };
          }
          const values = { ...interpolated(source.params, params), [fan.as ?? fan.field]: value as string | number };
          const op = getOp(connection, source.op)!;
          if (missingInputs(op, values).length > 0) {
            return { status: "missingInput", message: "It needs more inputs than the records around it give." };
          }
          bodies[source.as] = await read(source.op, values);
        }

        /*
         * A field the widget derives from, absent from every row of a
         * non-empty answer, is a column that would render blank forever —
         * which reads as broken data rather than a bad widget.
         */
        for (const source of sources) {
          const body = bodies[source.as];
          if (!Array.isArray(body) || body.length === 0) continue;
          const shape = inferShape(body, { rowsPath: "$" });
          const pipeline = widget.source ? widget.pipeline : source.pipeline;
          const fields = pipeline.flatMap((step) =>
            step.op === "derive" ? Object.values(step.fields) : [],
          );
          const paths = fields.filter(
            (field): field is string => typeof field === "string" && /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(field),
          );
          const missing = paths.filter((path) => !shape.fields.some((field) => field.name === path));
          if (missing.length > 0) {
            return {
              status: "schema",
              message: `This account's records do not carry ${missing.slice(0, 3).join(", ")}.`,
            };
          }
        }

        const nonEmpty = Object.values(bodies).some((body) =>
          Array.isArray(body) ? body.length > 0 : body !== null && body !== undefined,
        );
        const executed = executeWidget(widget, widget.source ? bodies.main : bodies, { now, params });
        if (nonEmpty && !executed.ok) {
          return { status: "schema", message: "What this account returned does not fit this widget." };
        }
        return {
          status: "ready",
          message: nonEmpty ? "Checked against your account." : "Your account can read these, and has none yet.",
        };
      } catch (error) {
        if (error instanceof BudgetSpent) {
          return { status: "unchecked", message: "Not checked, to spare your API. It loads when the board opens." };
        }
        if (error instanceof AdapterError) {
          if (error.status === 401) {
            throw new OnboardingError(
              `${connection.title} refused the key. Check it in Manage, then preview again.`,
            );
          }
          if (error.status === 403) {
            return { status: "denied", message: "This account is not allowed to read these records." };
          }
          if (error.status === 404) {
            return { status: "unavailable", message: "This account does not have this endpoint." };
          }
          if (error.status === 400 || error.status === 422) {
            return { status: "unavailable", message: "The API refused the request this widget makes." };
          }
          return {
            status: "unchecked",
            message:
              error.status === 429
                ? "The API asked us to wait, so this was not checked. It loads when the board opens."
                : "The API did not answer, so this was not checked. It loads when the board opens.",
          };
        }
        return { status: "schema", message: "What this account returned could not be read for this widget." };
      }
    };
  }

  /**
   * Create exactly the boards that were previewed.
   *
   * `creating` is written before any board is, with the ids it is about to
   * use, so a create that dies half way finishes the same boards on the next
   * try rather than making a second set — and never overwrites one that was
   * already written, which somebody may have started arranging.
   */
  async commit(id: string, previewId: string): Promise<OnboardingStatusView & { readonly created: readonly SetupBoard[] }> {
    return this.locked(`connection:${id}`, async () => {
      const connection = this.connection(id);
      const setup = this.setupOf(connection);
      const preview = setup.preview;
      if (!preview || preview.id !== previewId) {
        throw new OnboardingError("Preview again before creating: this is not the preview on record.");
      }
      const entry = this.requireEntry(connection);
      const { chosen, layout } = this.chosenFor(connection, entry);
      if (this.previewFingerprint(connection, entry, chosen, layout) !== preview.fingerprint) {
        throw new OnboardingError(
          "Something changed since this preview — the key, the endpoints or the API's parts. Preview again.",
        );
      }
      if (preview.boards.length === 0) {
        throw new OnboardingError("Nothing in this preview could be built. Choose other parts.");
      }

      /*
       * An id taken since the preview was reserved belongs to somebody else's
       * board. Re-reserved — unless this is a create being finished, where
       * the board under that id is the one this setup wrote.
       */
      let boards = preview.boards;
      if (setup.status !== "creating") {
        const taken = new Set(this.deps.dashboardIds());
        const reserved = new Set<string>();
        boards = boards.map((one) => {
          let boardId = one.board.id;
          if (taken.has(boardId) || reserved.has(boardId)) {
            boardId = allocateDashboardId(one.board.title, new Set([...taken, ...reserved]));
          }
          reserved.add(boardId);
          return boardId === one.board.id ? one : { ...one, board: { ...one.board, id: boardId } };
        });
      }
      const ids = boards.map((one) => one.board.id);
      this.save(id, { status: "creating", dashboards: ids, preview: { ...preview, boards } });

      for (const one of boards) {
        if (!this.deps.getDashboard(one.board.id)) this.deps.putDashboard(one.board);
      }

      const refused = preview.checks
        .filter((check) => check.status !== "ready" && check.status !== "unchecked")
        .map((check) => `“${check.title}” was left off: ${check.message}`);
      this.save(id, {
        status: "complete",
        dashboards: ids,
        at: new Date(this.now()).toISOString(),
        notes: [...refused, ...preview.notes].map((note) => note.slice(0, 400)).slice(0, 60),
        /* Kept only while it can still be needed: to finish a create. */
        preview: undefined,
      });
      this.deps.onChanged?.();

      const created = boards.map((one) => ({
        dashboard: one.board.id,
        title: one.board.title,
        widgets: one.board.widgets.length,
        ...(one.category ? { category: one.category } : {}),
      }));
      return { ...this.status(id), created };
    });
  }

  /**
   * Not now. The connection stays usable, and gets the plain board it would
   * have had before onboarding existed so there is somewhere to land.
   */
  skip(id: string): OnboardingStatusView {
    const connection = this.connection(id);
    const setup = this.setupOf(connection);
    if (setup.status !== "creating" && setup.status !== "complete") {
      this.save(id, { status: "skipped" });
    }
    if (setup.dashboards.length === 0) this.deps.ensureDefaultBoard?.(this.connection(id));
    return this.status(id);
  }

  /**
   * Another set. The boards already made are left exactly as they are —
   * somebody setting up again has usually changed their mind about what they
   * want, not about the board they have been arranging since. Also the way
   * out of an interrupted create whose connection has since changed.
   */
  restart(id: string): OnboardingStatusView {
    this.connection(id);
    this.save(id, { status: "choosing", preview: undefined, dashboards: [], notes: [] });
    return this.status(id);
  }
}

/** The preview ran out of reads. Not an error: the widget is kept unchecked. */
class BudgetSpent extends Error {}

/** A source's parameters, filled with the board's defaults. */
const interpolated = (
  params: Readonly<Record<string, string | number | boolean>>,
  resolved: ResolvedParams,
): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(params)) out[name] = interpolateValue(value, resolved);
  return out;
};
