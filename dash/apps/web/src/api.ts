import type {
  CatalogEntry,
  ConnectionSpec,
  Presentation,
  PresentationManifest,
  ResourceSpec,
  WidgetSpec,
} from "@freebirdai/dash-spec";

/** The connection as the server reports it — secrets replaced by a boolean. */
export interface ConnectionSummary extends ConnectionSpec {
  hasKey: boolean;
}

export interface SampleField {
  name: string;
  kinds: string[];
  format: string | null;
  nullable: boolean;
  samples: unknown[];
}

export interface SampleResult {
  rowsPath: string;
  rowCount: number;
  schemaHash: string;
  fields: SampleField[];
  meta: { url: string; pages: number; truncated: boolean; warnings: string[] };
  sample: unknown[];
}

export interface PresentationResult {
  /** Resolved across the parts layers, keyed by component id. */
  presentation: Record<string, Presentation>;
  /** Stored overrides that no longer parse, so a dead one is visible. */
  invalid: Array<{ id: string; detail: string }>;
  /** Board-wide token overrides from the stored `theme` part. */
  theme: Record<string, string>;
  /** What each component offers, which is what the editor enumerates. */
  manifests: Record<string, PresentationManifest>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The server already phrases failures for a person to read, so pass its
 * message through rather than replacing it with something more generic.
 */
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError("The Dash server isn't responding. Is it running?", 0);
  }

  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string; detail?: unknown })
    | null;

  if (!response.ok) {
    throw new ApiError(
      payload?.error ?? `Request failed (${response.status})`,
      response.status,
      payload?.detail,
    );
  }
  return payload as T;
};

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** A machine-readable page index the docs site publishes. */
export interface DocsIndex {
  url: string;
  /** The path prefix the pages were scoped to — the submitted URL's section. */
  section: string;
  pages: number;
  estimatedMs: number;
}

export interface DiscoveryResult {
  source: "catalog" | "openapi" | "docs" | "none";
  entry: CatalogEntry | null;
  note: string;
  warnings: string[];
  tried: string[];
  /** Present when the site publishes a page index the ladder found. */
  index?: DocsIndex;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: "anthropic" | "openai";
  supportsTemperature: boolean;
  note: string;
  /** False when the provider's key is missing — shown, but not selectable. */
  available: boolean;
}

/** One AI action, and which model has been routed to it. */
export interface TaskOption {
  id: string;
  /** A person's name for the action, e.g. "Building a widget". */
  label: string;
  tier: "capable" | "fast";
  /** When it runs, in the user's terms — why its tier is what it is. */
  note: string;
  /** What was explicitly chosen for this action, or null for the default. */
  selected: string | null;
  /** What will actually run. */
  effective: string | null;
  /** Where `effective` came from — an env pin, a choice, or the default. */
  source: "env" | "task" | "global" | "tier" | "none";
  /** False when the routed model's provider has no key. */
  available: boolean;
}

/** What one task has cost this server run. */
export interface SpendTotals {
  usd: number;
  calls: number;
  /** Calls whose model has no rate on file — real tokens, unknown price. */
  unpriced: number;
}

/** One provider the server can reach, or would if it had the key. */
export interface ProviderOption {
  id: "anthropic" | "openai";
  /** What people call it, which is not always what the API is called. */
  label: string;
  /** The environment variable this provider needs. */
  keyVar: string;
  /** Which models it means, in one line. */
  note: string;
  available: boolean;
}

/** What every write to /api/models returns, so the picker never re-fetches. */
export interface ModelWriteResult {
  provider: "anthropic" | "openai" | null;
  effectiveProvider: "anthropic" | "openai" | null;
  /** What "Default" resolves to, with any stored choice taken out. */
  defaultProvider: "anthropic" | "openai" | null;
  selected: string | null;
  effective: string | null;
  tasks: TaskOption[];
  /** Per-action choices dropped because they belonged to the old provider. */
  clearedTasks: string[];
  /** True when the "one model for everything" choice was dropped too. */
  clearedGlobal: boolean;
}

export interface ModelsResult {
  providers: { anthropic: boolean; openai: boolean };
  /** The providers to choose between, and whether each one has a key. */
  providerOptions: ProviderOption[];
  /** The chosen provider, or null for the built-in default. */
  provider: "anthropic" | "openai" | null;
  /** Which provider is actually in force — differs when the chosen one has no key. */
  effectiveProvider: "anthropic" | "openai" | null;
  /** What "Default" resolves to, with any stored choice taken out. */
  defaultProvider: "anthropic" | "openai" | null;
  models: ModelOption[];
  /** The "use one model for everything" override, or null for per-task. */
  selected: string | null;
  /** What that override resolves to. Per-action answers live on `tasks`. */
  effective: string | null;
  /** DASH_LLM_MODEL is set, so the picker cannot change anything. */
  pinnedByEnv: boolean;
  tasks: TaskOption[];
  /** AI spend since the server started, and what each action spent. */
  spend: SpendTotals & { byTask: Record<string, SpendTotals> };
  /** The date the price table was read. Stale is a reason to re-check. */
  ratesAsOf: string;
}

/**
 * What a connection turns out to be able to do, worked out from its own
 * endpoints and a few sampled responses.
 *
 * The server derives all of this; the UI's whole job is to show it and collect
 * a yes. Nothing here is stored until `setResources` is called.
 */
export interface DrillDownOffer {
  resource: string;
  title: string;
  listOp: string;
  detailOp: string;
  idField: string;
  detailParam: string;
  labelField?: string;
  sampled: boolean;
}

export interface JoinOffer {
  from: string;
  to: string;
  title: string;
  foreignField: string;
  targetField: string;
  filterParam?: string;
  needsFanOut: boolean;
}

export interface AuthoredWidget {
  id: string;
  source: "model" | "rule" | "chat";
  widget: unknown;
  headline: string;
  why: string[];
  confirm: Array<{ field: string; question: string; options: string[] }>;
  confidence: "declared" | "inferred";
  cost: { requests: number; onOpen: number };
  score: number;
}

export interface SuggestionsResult {
  /** Written by rule. Same input, same list, every time. */
  suggestions: AuthoredWidget[];
  /** A model's second opinion, kept separate so the two can be compared. */
  reviewed: AuthoredWidget[];
  /** Which model reviewed, or null when none was available. */
  reviewModel: string | null;
  reviewError: string | null;
  notes: string[];
  /** How the read ended — the difference between "empty" and "refused". */
  outcome: "complete" | "budget" | "rateLimited" | "authRejected";
  retryAfter?: string;
  /** Endpoints understood structurally. */
  resourceCount: number;
  /** Endpoints that actually returned rows. Zero with a high resourceCount
   *  means the shape is known but the API would not answer. */
  sampledCount: number;
  /**
   * Pairings this pass checked against real rows, confirmed and rejected both.
   *
   * The rejections are the useful half: without them a link the model found
   * but could not stand behind is indistinguishable from one it never saw, and
   * the engine reads as having missed something obvious.
   */
  relationships: Array<{
    parent: string;
    child: string;
    linkField: string;
    ok: boolean;
    reason?: string;
  }>;
}

/** The relationship graph as it currently stands, read at no request cost. */
export interface RelationsResult {
  connection: string;
  resources: ResourceSpec[];
  fieldsByResource: Record<string, string[]>;
  /** Where the answer came from — a current report, a stale one, or the URLs alone. */
  source: "report" | "stale" | "endpoints";
  lastRead: string | null;
}

export interface UnknownResource {
  resource: string;
  title: string;
  reason:
    | "empty"
    | "unsampled"
    | "needsParent"
    | "needsInput"
    | "requestFailed"
    | "aborted";
  recheckOp?: string;
  needs?: string[];
  detail?: string;
}

/**
 * What reading a connection will cost, answered without making a request.
 *
 * Exists so the question can be put to someone with a real number attached
 * rather than as a vague warning about rate limits.
 */
export interface EnumerationPlan {
  collections: number;
  estimatedRequests: number;
  /** How long the paced pass will take, so the bar can be determinate. */
  estimatedMs: number;
  willSampleChildren: boolean;
  /** A matching report already exists, so this costs nothing right now. */
  alreadyRead: boolean;
  /** A report exists but describes different endpoints. */
  stale: boolean;
  lastRead: string | null;
  previousOutcome: "complete" | "budget" | "rateLimited" | "authRejected" | null;
}

export interface Capabilities {
  connection: string;
  resources: ResourceSpec[];
  drillDowns: DrillDownOffer[];
  joins: JoinOffer[];
  unknowns: UnknownResource[];
  /** Field names seen on each sampled resource, so columns bind to real data. */
  fieldsByResource: Record<string, string[]>;
  searchable: Array<{ op: string; param: string }>;
  rangeFilterable: Array<{ op: string; start: string; end?: string }>;
  notes: string[];
  outcome: "complete" | "budget" | "rateLimited" | "authRejected";
  requestsSpent: number;
  retryAfter?: string;
}

/* ── guided setup ─────────────────────────────────────────────────────── */

export interface ConciergeOption {
  value: string;
  label: string;
  description: string | null;
  recommended: boolean;
}

export interface ConciergeStep {
  stepId: string;
  question: string;
  help: string | null;
  multiple: boolean;
  skippable: boolean;
  /** A typed answer is accepted instead of an option. */
  freeText: boolean;
  options: ConciergeOption[];
}

/**
 * One decision on the approval card.
 *
 * The same shape as a question, plus what it is currently set to — because a
 * control and a question are the same thing seen from different ends. Opening
 * one is how a chip becomes editable.
 */
export interface ConciergeControl extends ConciergeStep {
  value: string[];
  settled: boolean;
  /** A widget cannot exist without this one. */
  required: boolean;
}

/** One way several widgets could be shown together. */
export interface ArrangementOption {
  id: "tabs" | "row" | "stack" | "list" | "merged";
  label: string;
  description: string;
  /** True of the one the setup is currently built as. */
  applied: boolean;
  /** Requests this costs beyond what the setup already spends. */
  extraRequests: number;
}

export interface ConciergeSummary {
  widgetId: string;
  title: string;
  component: string;
  headline: string;
  why: string[];
  /** Requests to render it once it is on the board. */
  requests: number;
  /** Extra requests each time a row is opened. */
  onOpen: number;
}

/** Something still missing before a widget can be built. */
export interface ConciergeMissing {
  stepId: string;
  need: string;
  candidates: string[];
}

export interface ConciergeActive {
  active: true;
  draftId: string;
  /** `assisted` is the assistant proposing; `wizard` is one question at a time. */
  mode: "assisted" | "wizard";
  intent: string | null;
  /**
   * When the setup began, as an ISO instant, or null for a draft written
   * before this was recorded.
   *
   * The card reads it to tell a setup that started moments ago from one left
   * lying around — see `ConciergeCard`, where the difference decides whether
   * somebody is asked a question or simply carried on.
   */
  startedAt: string | null;
  ready: boolean;
  missing: ConciergeMissing[];
  /** The next question, or null when there is nothing left to ask. */
  step: ConciergeStep | null;
  controls: ConciergeControl[];
  remaining: number;
  /**
   * The draft widget itself.
   *
   * Rendered live by the card through the same `WidgetShell` the board uses,
   * so what is previewed is what lands.
   */
  widget: WidgetSpec | null;
  /**
   * Every widget the setup will write, in order.
   *
   * One for almost every setup, and `widget` is its first entry — so anything
   * that only ever cared about a single widget goes on reading that. Two or
   * more when the request was for separate things seen together, which is not
   * one widget with two datasets but two widgets.
   */
  widgets: WidgetSpec[];
  /** How they are to be shown together, when the setup asked for a frame. */
  group: { title: string; display: "tabs" | "row" | "stack" } | null;
  /**
   * The other ways these could be shown, each with what it costs.
   *
   * Empty for a setup of one widget, which is almost all of them. Every entry
   * was derived from the endpoints, so anything offered here can really be
   * built — the picker never shows a possibility that turns out not to be one.
   */
  arrangements: ArrangementOption[];
  summary: ConciergeSummary | null;
  warnings: string[];
  errors: string[];
  /** Dashboard filters that will be declared alongside the widget. */
  filters: string[];
}

export type ConciergeState = { active: false } | ConciergeActive;

/**
 * Extras the answer route adds when the answer *did* something.
 *
 * Two steps are effects rather than values — connecting an API and reading one
 * — so their response carries what happened alongside the next question.
 */
export interface ConciergeEffect {
  /** A panel to open. Credentials are entered there, never in the chat. */
  open?: "connections";
  /** Why a read did not complete, when it did not. */
  readFailed?: string;
}

/** A name the setup would not accept, and what it would have. */
export interface ConciergeRejection {
  stepId: string;
  value: string;
  available: string[];
  reason: string;
}

/** Any part of the widget, set in one go. */
export interface ConciergePatch {
  connection?: string;
  endpoint?: string;
  join?: string;
  component?: string;
  /** What the widget counts: `count:`, or `<aggregation>:<field>`. */
  measure?: string;
  /** The field the rows are broken up by. */
  groupBy?: string;
  /** Take a measurement that costs requests, or leave it out. */
  offer?: "include" | "skip";
  /** Which of two readings of the request was meant, as an endpoint id. */
  choice?: string;
  roles?: Record<string, string[]>;
  controls?: string[];
  drilldown?: string;
  drilldownFields?: string[];
  extras?: string[];
  highlights?: string[];
  title?: string;
  /** Step ids to mark declined, which is not the same as setting nothing. */
  skip?: string[];
  /**
   * The same patch, aimed at one of the other widgets in the setup.
   *
   * Index zero here is the *second* widget: the patch's own fields are the
   * first. Declared because zod strips what it has not heard of, so a control
   * for the second widget without this arrives as a patch that changes
   * nothing and reports success.
   */
  parts?: ConciergePatch[];
  group?: { title: string; display?: "tabs" | "row" | "stack" };
  interleave?: boolean;
}

export interface MapState {
  readonly mapped: boolean;
  /** Mapped by an older pass than the current one. Worth re-running. */
  readonly stale: boolean;
  readonly endpoints: number;
  readonly described: number;
  readonly withFields: number;
  /** How many endpoints would need a real request to describe. Often zero. */
  readonly wouldSample: number;
  /** False when there is no model configured to run the pass. */
  readonly canRun: boolean;
}

export interface MapRunResult extends MapState {
  readonly ranPass: boolean;
  readonly mappedAt: string | null;
  readonly descriptionsWritten: number;
  readonly relationsFound: number;
  /** Batches fail independently, so a partial map says what it is missing. */
  readonly errors: readonly string[];
}

export const api = {
  /* ── guided setup ───────────────────────────────────────────────────── */

  concierge: (dashboardId: string): Promise<ConciergeState> =>
    request(`/api/concierge/${encodeURIComponent(dashboardId)}`),

  startSetup: (
    dashboardId: string,
    intent?: string,
    mode: "assisted" | "wizard" = "wizard",
  ): Promise<ConciergeState> =>
    request(`/api/concierge/${encodeURIComponent(dashboardId)}/start`, json({ intent, mode })),

  /**
   * Set any part of the widget, several at once.
   *
   * What a control on the approval card posts, and the same door the assistant
   * comes through. `rejected` names anything that was not on offer rather than
   * dropping it quietly.
   */
  reviseSetup: (
    dashboardId: string,
    patch: ConciergePatch,
  ): Promise<ConciergeState & { rejected: ConciergeRejection[] }> =>
    request(`/api/concierge/${encodeURIComponent(dashboardId)}/revise`, json(patch)),

  /**
   * Swap how several widgets are shown together.
   *
   * Its own call rather than a field on `reviseSetup`, because it is a
   * different kind of change: revise adjusts one widget's bindings, and this
   * can turn two widgets into one. It may also spend a model call re-reading
   * the fields, which revise promises not to.
   */
  setArrangement: (
    dashboardId: string,
    arrangement: ArrangementOption["id"],
  ): Promise<ConciergeState & { notes?: string[] }> =>
    request(
      `/api/concierge/${encodeURIComponent(dashboardId)}/arrangement`,
      json({ arrangement }),
    ),

  /**
   * Record one answer and get the next question.
   *
   * `stepId` travels with the answer so a card left on screen through a reload
   * cannot apply its choice to whatever question has since become current —
   * the server answers 409 with the real state rather than binding the wrong
   * field to a role.
   */
  answerStep: (
    dashboardId: string,
    stepId: string,
    values: string[],
    skip = false,
  ): Promise<ConciergeState & ConciergeEffect> =>
    request(`/api/concierge/${encodeURIComponent(dashboardId)}/answer`, json({ stepId, values, skip })),

  confirmSetup: (
    dashboardId: string,
    title?: string,
  ): Promise<{ added: boolean; widgetId: string; title: string; warnings: string[]; filtersAdded: string[] }> =>
    request(`/api/concierge/${encodeURIComponent(dashboardId)}/confirm`, json({ title })),

  cancelSetup: (dashboardId: string): Promise<{ cleared: boolean }> =>
    request(`/api/concierge/${encodeURIComponent(dashboardId)}`, { method: "DELETE" }),

  models: (): Promise<ModelsResult> => request("/api/models"),

  /**
   * Choose whose models to run. Everything not pinned individually follows.
   *
   * Pins belonging to the provider being left are dropped by the server and
   * named in `clearedTasks`, because a switch that quietly left a third of the
   * actions on the old provider would be a control that lied.
   */
  setProvider: (provider: "anthropic" | "openai" | null): Promise<ModelWriteResult> =>
    request("/api/models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
    }),

  /** Omit `task` to set the global override; name one to route just it. */
  setModel: (model: string | null, task?: string): Promise<ModelWriteResult> =>
    request("/api/models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task ? { model, task } : { model }),
    }),

  /**
   * Liveness, and whether the assistant exists on this server.
   *
   * `chat` is false when chat storage could not be opened — the rest of the
   * app is unaffected by design, so the client has to ask rather than infer.
   */
  health: (): Promise<{ ok: boolean; chat?: boolean }> => request("/api/health"),

  catalog: (): Promise<CatalogEntry[]> => request("/api/catalog"),

  /**
   * Whether this API has been mapped, and what mapping it would involve.
   *
   * Costs nothing to ask — every count is read off the stored entry — so the
   * wizard can gate on it without spending anything to find out.
   */
  mapState: (catalogId: string): Promise<MapState> =>
    request(`/api/catalog/${catalogId}/map`),

  /**
   * Map the API: describe every endpoint, and infer how its resources relate.
   *
   * Expensive once, in model tokens rather than in requests against somebody's
   * API — the schemas come out of the spec for nothing. The result is a
   * property of the API rather than of this account, which is what makes it
   * worth doing once and sharing.
   */
  mapApi: (catalogId: string, force = false): Promise<MapRunResult> =>
    request(`/api/catalog/${catalogId}/map`, json({ force })),

  presentation: (): Promise<PresentationResult> => request("/api/presentation"),

  /**
   * Store a look for every board.
   *
   * An override is a whole part rather than a diff, so this sends the merged
   * object and reverting is a delete rather than unwinding a patch.
   */
  putPresentation: (id: string, data: Presentation): Promise<{ ok: boolean; layer: string }> =>
    request(`/api/parts/presentation/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: "data", data }),
    }),

  revertPresentation: (id: string): Promise<{ ok: boolean; layer: string }> =>
    request(`/api/parts/presentation/${id}`, { method: "DELETE" }),

  /**
   * Read every documented page in a section and merge them.
   *
   * One request per page against someone else's documentation site, so this
   * only runs after the count and the time have been shown and accepted.
   */
  readIndex: (url: string): Promise<DiscoveryResult> =>
    request("/api/discover/read-index", json({ url })),

  discover: (url: string): Promise<DiscoveryResult> => request("/api/discover", json({ url })),

  saveCatalogEntry: (entry: CatalogEntry): Promise<CatalogEntry> =>
    request(`/api/catalog/${entry.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }),

  connections: (): Promise<ConnectionSummary[]> => request("/api/connections"),

  createFromCatalog: (input: {
    catalogId: string;
    id?: string;
    opIds?: string[];
  }): Promise<ConnectionSummary & { needsKey: boolean }> =>
    request("/api/connections/from-catalog", json(input)),

  saveConnection: (id: string, spec: unknown): Promise<ConnectionSummary> =>
    request(`/api/connections/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    }),

  addOp: (id: string, op: Record<string, unknown>): Promise<ConnectionSummary> =>
    request(`/api/connections/${id}/ops`, json(op)),

  removeOp: (id: string, opId: string): Promise<ConnectionSummary> =>
    request(`/api/connections/${id}/ops/${opId}`, { method: "DELETE" }),

  availableOps: (id: string): Promise<Array<{ id: string; title: string; path: string; archetype: string }>> =>
    request(`/api/connections/${id}/available-ops`),

  deleteConnection: (id: string): Promise<{ ok: boolean }> =>
    request(`/api/connections/${id}`, { method: "DELETE" }),

  // PUT, not POST — the route is idempotent and the mismatch 404s silently.
  setKey: (id: string, key: string): Promise<{ ok: boolean }> =>
    request(`/api/connections/${id}/key`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    }),

  /** Multi-secret form: keyRef → value. Works for single-secret auth too. */
  setKeys: (id: string, keys: Record<string, string>): Promise<{ ok: boolean }> =>
    request(`/api/connections/${id}/key`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys }),
    }),

  /**
   * Prove the credentials work.
   *
   * `forbidden` names the endpoints the key was *not* allowed to read — still
   * a pass, because being refused a resource means the API identified the
   * caller first. A list rather than one id: validation now walks a candidate
   * list rather than concluding on the first refusal, so several can be
   * refused before one answers. The caller should sample something else.
   *
   * `validatedOpId` names the one that did answer, when any did.
   */
  validate: (
    id: string,
  ): Promise<{
    ok: boolean;
    message: string;
    pages?: number;
    forbidden?: string[];
    failed?: string[];
    verified?: boolean;
    validatedOpId?: string;
    adoptedValidateOpId?: string;
  }> =>
    request(`/api/connections/${id}/validate`, json({})),

  sample: (id: string, op: string): Promise<SampleResult> =>
    request(`/api/connections/${id}/sample`, json({ op })),

  /**
   * What is worth building here, phrased as sentences.
   *
   * Deterministic — no model involved — and it returns real widget specs, so
   * an offer can be previewed and saved through the same path a model's
   * proposal takes.
   */
  suggestions: (id: string, refresh = false): Promise<SuggestionsResult> =>
    request(`/api/connections/${id}/suggestions`, json({ refresh })),

  /** A POST because it samples the API for real. Changes nothing. */
  capabilities: (id: string, refresh = false, deep = false): Promise<Capabilities> =>
    request(`/api/connections/${id}/capabilities`, json({ refresh, deep })),

  /** Costs nothing: everything in the answer is read off the endpoints. */
  enumerationPlan: (id: string, deep = false): Promise<EnumerationPlan> =>
    request(`/api/connections/${id}/enumeration-plan${deep ? "?deep=true" : ""}`),

  /** Free: reads the stored report, or the endpoint graph when there is none. */
  relations: (id: string): Promise<RelationsResult> =>
    request(`/api/connections/${id}/relations`),

  /** The approval step: the proposal above, accepted onto the connection. */
  setResources: (id: string, resources: ResourceSpec[]): Promise<ConnectionSummary> =>
    request(`/api/connections/${id}/resources`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resources }),
    }),
};
