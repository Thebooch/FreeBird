import type { ChatMessage } from "@freebirdai/core";
import type { EachAnswer, EachRequest } from "@freebirdai/dash-react";
import type {
  AgentInput,
  AgentSpec,
  AppointmentType,
  Block,
  Booking,
  BookingStatus,
  CalendarEntryInput,
  CalendarEvent,
  Contact,
  ContactFieldDef,
  ContactFieldDefInput,
  ContactInput,
  ContactMatchRule,
  ContactMatchRuleInput,
  MatchOutcome,
  Occurrence,
  PartialSettings,
  Placement,
  Pool,
  Principal,
  Role,
  SchedulingProfile,
  Task,
  TaskStatus,
  WorkflowCase,
  WorkflowTemplate,
  SharedAgentKnowledge,
  WorkflowInput,
  WorkflowRun,
  WorkflowSpec,
  WriteReviewView,
  ApiProfile,
  CatalogEntry,
  ConnectionSpec,
  DashboardSpec,
  Presentation,
  PresentationManifest,
  ResourceSpec,
  SemanticType,
  WidgetBrief,
  WidgetSpec,
} from "@freebirdai/dash-spec";

/** The connection as the server reports it — secrets replaced by a boolean. */
/** A booking link as the contact sheet lists it. */
export interface BookingLinkInfo {
  readonly id: string;
  readonly type?: string;
  readonly booking?: string;
  /** Made on the public link, where anyone can type an email. */
  readonly fromPublic: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface ConnectionSummary extends ConnectionSpec {
  hasKey: boolean;
}

/** What checking a connection found. See `routes/integrate.ts` on the server. */
export interface IntegrationResult {
  readonly outcome: "ready" | "partial" | "blocked";
  readonly blocked?: string;
  readonly changes: readonly string[];
  readonly ops: ReadonlyArray<{
    readonly op: string;
    readonly title: string;
    readonly outcome: "ready" | "blocked" | "skipped";
    readonly level?: string;
    readonly note: string;
  }>;
  readonly requests: number;
  readonly modelCalls: number;
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

/** Scheduling's setup, as `GET /api/scheduling` serves it. */
export interface SchedulingOverview {
  readonly defaults: PartialSettings;
  readonly profiles: SchedulingProfile[];
  readonly pools: Pool[];
  readonly types: AppointmentType[];
  readonly blocks: Block[];
  readonly placements: Placement[];
  readonly members: ReadonlyArray<{ readonly userId: string; readonly email: string; readonly role: Role }>;
}

/** One block occurrence on one host's calendar. */
export interface HostOccurrence extends Occurrence {
  readonly host: string;
  readonly kind: Block["kind"];
  readonly setTo?: string;
}

/** Contact field definitions and match rules, as `GET /api/contacts/setup` serves them. */
export interface ContactSetup {
  readonly fields: ContactFieldDef[];
  readonly matchRules: ContactMatchRule[];
}

/** A record type a contact field can come from, with its fields and values seen in them. */
export interface ContactSource {
  readonly connection: string;
  readonly title: string;
  readonly entities: ReadonlyArray<{
    readonly entity: string;
    readonly name: string;
    readonly fields: ReadonlyArray<{ readonly path: string; readonly label?: string; readonly samples: readonly string[] }>;
  }>;
}

/** Which record a contact is linked to. */
export interface RecordTarget {
  readonly connection: string;
  readonly entity: string;
  readonly recordId: string;
}

/** Open times, as the slot engine offers them. */
export interface SlotPreview {
  readonly slots: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly approval: boolean;
    readonly consolidated: boolean;
    readonly options: ReadonlyArray<{ readonly host: string; readonly block?: string; readonly approval: boolean; readonly consolidated: boolean }>;
  }>;
  readonly needs: readonly string[];
  readonly consolidatedOnly: boolean;
  readonly more: boolean;
}

/** The Overview: see `buildOverview` on the server. */
export interface AgentOverview {
  readonly active: ReadonlyArray<{
    readonly workflow: string;
    readonly name: string;
    readonly agents: readonly string[];
    readonly state: "running" | "waiting_approval" | "waiting" | "waiting_schedule" | "waiting_trigger" | "waiting_agent" | "paused";
    readonly stage: string;
    readonly waitingFor: string;
    readonly tasks: readonly string[];
    readonly waiting: number;
    readonly cases: ReadonlyArray<{ readonly id: string; readonly rowKey?: string; readonly status: string; readonly step?: string; readonly waitingFor?: string; readonly deadline?: string; readonly since: string }>;
    readonly since?: string;
    readonly nextAt?: string;
  }>;
  readonly completed: ReadonlyArray<{
    readonly id: string;
    readonly at: string;
    readonly task: string;
    readonly action: string;
    readonly title: string;
    readonly status: string;
    readonly workflow?: string;
    readonly workflowName?: string;
    readonly agent?: string;
    readonly case?: string;
    readonly by?: string;
    readonly reversible: boolean;
  }>;
}

/** What a workflow would do now: see `previewWorkflow` on the server. */
export interface WorkflowPreview {
  readonly read: number;
  readonly complete: boolean;
  readonly seeding: boolean;
  readonly matched: number;
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly fields: Readonly<Record<string, unknown>>;
    readonly path: ReadonlyArray<{ readonly node: string; readonly name: string; readonly mode: "auto" | "approve"; readonly stops?: string; readonly skipped?: boolean }>;
  }>;
  readonly problem?: string;
}

/** A draft, explained: see `explainDraft` on the server. */
export interface WorkflowCheck {
  readonly sentence: string;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly picked: string; readonly mode: string; readonly name: string }>;
  readonly questions: ReadonlyArray<{ readonly step?: string; readonly field?: string; readonly question: string; readonly default?: string; readonly kind: "missing" | "suggestion" }>;
  readonly problems: ReadonlyArray<{ readonly step?: string; readonly field?: string; readonly message: string }>;
}

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
  /**
   * The documentation is drawn by its own scripts, and reading it needs
   * Chromium, which is not here yet: the person is asked once.
   */
  needsRenderer?: boolean;
}

/** Chromium for reading documentation drawn by scripts: whether it is here, and the download's progress. */
export interface RendererStatus {
  state: "ready" | "missing" | "installing" | "failed" | "off";
  progress?: number;
  /** Which file of the download is coming: Chromium comes in more than one. */
  part?: number;
  error?: string;
  consented: boolean;
  downloadMb: number;
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

/** The relationship graph as it currently stands, read at no request cost. */
export interface RelationsResult {
  connection: string;
  resources: ResourceSpec[];
  fieldsByResource: Record<string, string[]>;
  /** Where the answer came from — a current report, a stale one, or the URLs alone. */
  source: "report" | "stale" | "endpoints";
  lastRead: string | null;
}

/**
 * Every link between record types, and what it would take to correct one.
 *
 * Distinct from `RelationsResult`, which describes the endpoint-level model:
 * these are the links on the *record types*, which are what a widget is
 * compiled from and what a record page follows.
 */
export interface ReferencesResult {
  described: boolean;
  entities: { id: string; title: string }[];
  links: {
    entity: string;
    from: string;
    field: string;
    label: string;
    target: string;
    to: string;
    cost: "free" | "cheap" | "partial";
    /** False for a link nothing here can follow — it renders as a bare id. */
    openable: boolean;
    verified: boolean;
  }[];
  /**
   * Fields that look like a link and are not recorded as one.
   *
   * What lets a missed link be added — and what keeps a field somebody has
   * just called "not a link" on the screen that could put it back.
   */
  candidates: { entity: string; from: string; field: string; label: string }[];
  unreachable: { from: string; field: string; reason: string }[];
}

export interface UnknownResource {
  resource: string;
  title: string;
  reason: "empty" | "unsampled" | "needsParent" | "needsInput" | "requestFailed" | "aborted";
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
/**
 * A widget's own settings, as the server derives them.
 *
 * `brief` is null for a widget that was not built from a request — everything
 * made before briefs existed, and anything the setup card re-answered
 * afterwards. Those keep the settings they always had, which is how they look,
 * and `unavailable` says so when the reason is worth a sentence.
 */
export interface WidgetSettings {
  brief: WidgetBrief | null;
  controls: ConciergeControl[];
  unavailable?: string;
}

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
  /**
   * What this setup already put on the board, or null until it lands.
   *
   * `current` is false while a change the board does not show yet is waiting
   * for its preview to check out; the card then writes it over the same tiles.
   */
  placed: { widgetIds: string[]; current: boolean } | null;
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
  /**
   * The other reading of the same request, as a phrase to click.
   *
   * Null on almost every setup. It is what the assistant did *not* build from
   * the same words — the records rather than a count of them, usually — and it
   * was written by the call that wrote the brief, so taking it costs no second
   * model call and no second wait.
   */
  alternative: { label: string } | null;
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
export type ConciergePatch = import("@freebirdai/dash-agent").DraftPatch;

/**
 * How an API divides up, and what each part opens with.
 *
 * Read off the stored integration, so opening the panel costs nothing. The
 * counts are separate on purpose: an API can be divided into parts before
 * every part has a starting dashboard, and that half-finished state is a real
 * one the screen has to be able to describe.
 */
export interface CategoryState {
  readonly divided: boolean;
  /** Divided against an older reading of the API. Worth preparing again. */
  readonly stale: boolean;
  readonly categories: number;
  /** Parts that have a widget set. */
  readonly composed: number;
  readonly pending: number;
  readonly empty: number;
  readonly failed: number;
  readonly starters: number;
  readonly entities: number;
  /** Whether how often records arrive has been read. */
  readonly rhythm: boolean;
  /** Steps of preparation left. Zero when everything is ready. */
  readonly remaining: number;
  readonly categoriesAt: string | null;
  /** False when there is no model configured to run the passes. */
  readonly canRun: boolean;
  /** The record types are still being described; setup waits for them. */
  readonly describing?: boolean;
}

export type CategoryStatus = "pending" | "ready" | "empty" | "failed";

/** One part of an API, as it applies to one connection. */
export interface CategoryOffer {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: CategoryStatus;
  readonly recordTypes: number;
  readonly endpoints: number;
  readonly widgets: number;
  /** What it opens with, so the choice is not made blind. */
  readonly opensWith: readonly string[];
  readonly available: boolean;
  readonly unavailable?: string;
}

export type BoardLayout = "single" | "per-category";

/** How one widget fared when it was tried against the account. */
export interface WidgetCheck {
  readonly category: string;
  readonly widget: string;
  readonly title: string;
  readonly status: "ready" | "partial" | "unchecked" | "denied" | "unavailable" | "missingInput" | "schema";
  readonly message: string;
}

export interface OnboardingPreview {
  readonly id: string;
  readonly boards: ReadonlyArray<{ readonly category?: string; readonly board: DashboardSpec }>;
  readonly checks: readonly WidgetCheck[];
  readonly notes: readonly string[];
}

/** Where one connection's setup stands. */
export interface OnboardingSetup {
  readonly status: "pending" | "choosing" | "preview" | "creating" | "complete" | "skipped";
  readonly choices?: { readonly categories: readonly string[]; readonly layout: BoardLayout };
  readonly preview?: OnboardingPreview;
  readonly dashboards: readonly string[];
  readonly at?: string;
  readonly notes: readonly string[];
}

export interface SetupBoard {
  readonly dashboard: string;
  readonly title: string;
  readonly widgets: number;
  readonly category?: string;
}

export interface OnboardingState {
  readonly connection: string;
  readonly title: string;
  readonly catalog: string | null;
  readonly profile?: ApiProfile;
  readonly state: CategoryState | null;
  /** Why setup cannot go further right now, when it cannot. */
  readonly reason?: string;
  readonly categories: readonly CategoryOffer[];
  readonly setup: OnboardingSetup;
  /** The boards the latest set made that still exist. */
  readonly boards: readonly SetupBoard[];
}

/** What one step of preparation did. */
export interface PrepareStep {
  readonly step: "divided" | "composed" | "rhythm" | "none";
  readonly ok: boolean;
  readonly category?: string;
  readonly error?: string;
  readonly skipped: readonly string[];
  readonly proposed: number;
  readonly kept: number;
}

/** One endpoint's refresh cadence, and what decided it. */
export interface RhythmEndpoint {
  readonly op: string;
  readonly title: string;
  /** What these rows are, in a reader's words. Null where nothing described them. */
  readonly records: string | null;
  readonly tier: string;
  readonly everyMs: number;
  /** `override` beats `measured` beats `model` beats `default`. */
  readonly source: "override" | "measured" | "model" | "default";
  readonly volatility?: "constant" | "daily" | "rare";
  /** Why it was read that way, for somebody deciding whether to agree. */
  readonly because?: string;
  /** On a board somebody opens, so its cadence is one they will feel. */
  readonly warmed: boolean;
}

export interface RhythmState {
  readonly connection: string;
  readonly title: string;
  readonly tiers: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly everyMs: number;
  }>;
  /** False when nobody has read this API for rhythm — everything is on the default. */
  readonly classified: boolean;
  readonly at: string | null;
  readonly endpoints: readonly RhythmEndpoint[];
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
  /** False when no model is configured for the describing pass. */
  readonly canRunRecords?: boolean;
  /** The record types built on those endpoints — the half a person sees. */
  readonly records?: RecordsState;
  /** When a live account last checked the descriptions. */
  readonly entitiesVerifiedAt?: string | null;
  /** The record types are being described at this moment. */
  readonly describing?: boolean;
}

/**
 * How far the record types have got, in the four numbers that matter.
 *
 * Deliberately not one "ready" flag: a record type with no identity cannot
 * open a page, one with no name shows a number where a name belongs, and an
 * API with no references between its records is a set of unrelated lists. A
 * low number here is a specific, fixable thing rather than a verdict.
 */
export interface RecordsState {
  readonly described: boolean;
  readonly stale: boolean;
  readonly entities: number;
  readonly withIdentity: number;
  readonly withName: number;
  readonly references: number;
  readonly fieldsDescribed: number;
  /** Record types a live account has confirmed. Never a model's opinion. */
  readonly verified: number;
  readonly referencesVerified: number;
  /** Record types whose real rows an account read has seen. */
  readonly read?: number;
  /** Fields whose real values turned out not to be what the docs declared. */
  readonly corrected?: number;
}

/** What the describing pass did, and what it declined to do. */
export interface DescribeRunResult extends RecordsState {
  readonly ranPass: boolean;
  readonly note?: string;
  /** Fields offered as possible links, against how many became one. */
  readonly considered?: number;
  readonly linked?: number;
  readonly errors?: readonly string[];
  /** Readings the pass refused. Not errors — it worked and declined to guess. */
  readonly skipped?: readonly string[];
}

/** What checking the descriptions against a live account settled. */
export interface RecordCheckResult {
  readonly checked: number;
  readonly identitiesConfirmed: number;
  readonly referencesResolved: number;
  /** What it actually cost, in requests against the user's own API. */
  readonly requests: number;
  readonly stopped: "budget" | "refused" | "rejected" | null;
  readonly notes: readonly string[];
}

export interface MapRunResult extends MapState {
  readonly ranPass: boolean;
  readonly mappedAt: string | null;
  readonly descriptionsWritten: number;
  readonly relationsFound: number;
  /** Batches fail independently, so a partial map says what it is missing. */
  readonly errors: readonly string[];
}

/* ── chat topics and the timeline (plan 3) ─────────────────────────────── */

/** A topic: one subject in the continuous chat. Its id is the chat session's. */
export interface ChatTopic {
  readonly id: string;
  readonly name: string;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly count: number;
}

/** Work that finished, listed in the timeline beside the topics. */
export interface ChatTimelineTask {
  readonly id: string;
  readonly kind: "run" | "task";
  readonly at: string;
  readonly title: string;
  readonly detail?: string;
  readonly status: string;
  readonly agent?: string;
  readonly workflow?: string;
  readonly link?: string;
}

export interface ChatDaySummary {
  readonly day: string;
  readonly messages: number;
  readonly topics: number;
  readonly tasks: number;
}

/** One day of the chat's stream, and the nearest days either side with messages. */
export interface ChatDayMessages {
  readonly day: string;
  readonly today: string;
  readonly messages: ChatMessage[];
  /** Topic names by id, for the dividers. */
  readonly topics: Readonly<Record<string, string>>;
  readonly prev: string | null;
  readonly next: string | null;
}

/** The browser's own time zone, so days match what the person sees. */
const timeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const api = {
  /** What a number tile was, day by day, since the server began keeping it. Free: nothing is asked of the API. */
  widgetHistory: async (dashboardId: string, widgetId: string): Promise<readonly { day: string; value: number }[]> =>
    (
      await request<{ points: { day: string; value: number }[] }>(
        `/api/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(widgetId)}/history`,
      )
    ).points,
  /**
   * The rest of a tile's per-record reads, read by the server in the
   * background; asked again until it answers "done". See `/api/query/each`.
   */
  readEach: (each: EachRequest): Promise<EachAnswer> => {
    const range = each.resolved.range;
    return request<EachAnswer>(
      "/api/query/each",
      json({
        connection: each.connection,
        op: each.op,
        params: each.params,
        input: each.input,
        values: each.values,
        range: {
          preset: range.preset,
          grain: range.grain,
          start: range.start,
          end: range.end,
          ...(range.all ? { all: true } : {}),
        },
        filters: each.resolved.filters,
      }),
    );
  },
  checkSetupPreview: (
    dashboardId: string,
    widget: WidgetSpec,
    receipts: readonly { as: string; receipt: string }[],
  ): Promise<{
    status: "checked" | "empty" | "partial" | "invalid" | "unchecked";
    errors: string[];
    warnings: string[];
  }> =>
    request(
      `/api/concierge/${encodeURIComponent(dashboardId)}/preview`,
      json({ widget, receipts }),
    ),
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
    request(`/api/concierge/${encodeURIComponent(dashboardId)}/arrangement`, json({ arrangement })),

  /**
   * Take the other reading of the same request.
   *
   * No body: the server holds the reading it offered, and sending it back
   * would give the two a chance to disagree about what was on the chip.
   */
  takeReading: (dashboardId: string): Promise<ConciergeState & { rejected: ConciergeRejection[] }> =>
    request(`/api/concierge/${encodeURIComponent(dashboardId)}/reading`, json({})),

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
    request(
      `/api/concierge/${encodeURIComponent(dashboardId)}/answer`,
      json({ stepId, values, skip }),
    ),

  confirmSetup: (
    dashboardId: string,
    title?: string,
  ): Promise<{
    added: boolean;
    /** True when it rewrote the widgets this setup had already placed. */
    replaced?: boolean;
    widgetId: string;
    title: string;
    warnings: string[];
    filtersAdded: string[];
  }> => request(`/api/concierge/${encodeURIComponent(dashboardId)}/confirm`, json({ title })),

  cancelSetup: (dashboardId: string): Promise<{ cleared: boolean }> =>
    request(`/api/concierge/${encodeURIComponent(dashboardId)}`, { method: "DELETE" }),

  /** Take what the setup placed back off the board, and end the setup. */
  undoSetup: (dashboardId: string): Promise<{ removed: string[] }> =>
    request(`/api/concierge/${encodeURIComponent(dashboardId)}/undo`, json({})),

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
  mapState: (catalogId: string): Promise<MapState> => request(`/api/catalog/${catalogId}/map`),

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

  /**
   * Check the descriptions against the real account.
   *
   * The only thing in the record layer that spends the user's API quota, which
   * is why it is never called on their behalf: a description can be
   * confidently wrong in ways no amount of re-reading would reveal, and the
   * two claims that matter — this field identifies a record, this field points
   * at that record type — can only be settled by asking.
   */
  /**
   * Change how a record type's page is laid out, for everybody who opens one.
   *
   * The record type's own answer rather than one widget's: every route into a
   * record — a link from another record, a shared URL, any widget's row —
   * arrives at the same page, so this improves all of them at once.
   */
  putRecordLayout: (
    connectionId: string,
    entity: string,
    layout: { facts: readonly string[]; groups: readonly { title: string; fields: readonly string[] }[] },
  ): Promise<{ facts: readonly string[]; groups: readonly { title: string; fields: readonly string[] }[] }> =>
    request(`/api/connections/${connectionId}/entities/${entity}/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(layout),
    }),

  /**
   * Describe what this API's records are: their names, fields and links.
   *
   * The pass everything entity-first rests on, and the one thing that had no
   * way to be started — it existed as a route and nothing ever called it, so
   * in practice an API was connected, mapped, and left with no record types at
   * all. Costs model tokens and **no requests against anybody's account**,
   * which is what makes the result worth sharing.
   */
  describeRecords: (catalogId: string, force = false): Promise<DescribeRunResult> =>
    request(`/api/catalog/${catalogId}/entities`, json({ force })),

  /** How this API divides up. Free — it reads the stored integration. */
  categoryState: (catalogId: string): Promise<CategoryState> =>
    request(`/api/catalog/${catalogId}/categories`),

  /** Where this connection's setup stands, and what it could be given. Free. */
  onboarding: (connectionId: string): Promise<OnboardingState> =>
    request(`/api/connections/${connectionId}/onboarding`),

  /**
   * One step of preparing the API behind a connection: divide it, compose a
   * part, or read how often its records arrive. Call until
   * `state.remaining` is zero.
   *
   * Model tokens and zero requests against anybody's account, paid once per
   * API: the answer describes the API rather than this account, so everybody
   * who connects it afterwards inherits it.
   */
  /**
   * Read the endpoints that matter, repair what the documentation got wrong,
   * confirm how each pages, and keep the result. Spends API requests, bounded.
   */
  integrateConnection: (connectionId: string): Promise<IntegrationResult> =>
    request(`/api/connections/${connectionId}/integrate`, json({})),

  /** Where to send somebody to sign in with the provider, and the return address it uses. */
  startSignIn: (connectionId: string): Promise<{ authorizeUrl: string; redirectUri: string }> =>
    request(`/api/connections/${connectionId}/oauth/start`, json({})),

  prepareOnboarding: (
    connectionId: string,
  ): Promise<OnboardingState & { readonly step: PrepareStep }> =>
    request(`/api/connections/${connectionId}/onboarding/prepare`, json({})),

  /** Save which parts were picked. Clears any preview. */
  chooseOnboarding: (
    connectionId: string,
    choices: { categories: readonly string[]; layout: BoardLayout },
  ): Promise<OnboardingState> =>
    request(`/api/connections/${connectionId}/onboarding/choices`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(choices),
    }),

  /**
   * The boards as they would be, each widget tried against the account.
   * Bounded reads, through the same cache the boards will read.
   */
  previewOnboarding: (connectionId: string): Promise<OnboardingState> =>
    request(`/api/connections/${connectionId}/onboarding/preview`, json({})),

  /** Create exactly what was previewed. Safe to repeat after an interruption. */
  commitOnboarding: (
    connectionId: string,
    previewId: string,
  ): Promise<OnboardingState & { readonly created: readonly SetupBoard[] }> =>
    request(`/api/connections/${connectionId}/onboarding/commit`, json({ previewId })),

  /** Not now. The connection gets a plain board to land on. */
  skipOnboarding: (connectionId: string): Promise<OnboardingState> =>
    request(`/api/connections/${connectionId}/onboarding/skip`, json({})),

  /** Another set. The boards already made are left alone. */
  restartOnboarding: (connectionId: string): Promise<OnboardingState> =>
    request(`/api/connections/${connectionId}/onboarding/restart`, json({})),

  /** How often each endpoint is asked again, and why. Free — nothing is fetched. */
  rhythm: (connectionId: string): Promise<RhythmState> =>
    request(`/api/connections/${connectionId}/rhythm`),

  /**
   * Move endpoints between cadences.
   *
   * Saved against this connection only: the reading being disagreed with is
   * shared with everybody who connects this API, and one person's preference
   * has no business travelling with it. `null` puts one back.
   */
  setRhythm: (
    connectionId: string,
    overrides: Readonly<Record<string, string | null>>,
  ): Promise<{ overrides: Record<string, string>; notes: string[] }> =>
    request(`/api/connections/${connectionId}/rhythm`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides }),
    }),

  checkRecords: (connectionId: string, budget?: number): Promise<RecordCheckResult> =>
    request(`/api/connections/${connectionId}/verify`, json(budget ? { budget } : {})),

  references: (connectionId: string): Promise<ReferencesResult> =>
    request(`/api/connections/${connectionId}/references`),

  /**
   * Correct where one field points, or say it points nowhere.
   *
   * One field at a time and `PUT`, because a reference is replaced whole —
   * and `null` is a real answer: a field that resembles a link and is not one
   * is worth saying so about.
   */
  setReference: (
    connectionId: string,
    entity: string,
    field: string,
    target: string | null,
  ): Promise<{ field: string; reference: unknown }> =>
    request(`/api/connections/${connectionId}/entities/${encodeURIComponent(entity)}/reference`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field, target }),
    }),

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

  /** Whether documentation drawn by scripts can be read here, and how far a download has got. */
  rendererStatus: (): Promise<RendererStatus> => request("/api/discover/renderer"),

  /** The person agreed: the one-time download starts, and the answer is kept. */
  installRenderer: (): Promise<RendererStatus> => request("/api/discover/renderer", json({})),

  saveCatalogEntry: (entry: CatalogEntry): Promise<CatalogEntry> =>
    request(`/api/catalog/${entry.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }),

  connections: (): Promise<ConnectionSummary[]> => request("/api/connections"),

  /** The record types a connection has, for choosing what an agent may touch. */
  connectionEntities: (
    connection: string,
  ): Promise<Array<{ entity: string; name: string; kind?: string; description?: string }>> =>
    request(`/api/connections/${encodeURIComponent(connection)}/entities`),

  agents: (archived = false): Promise<AgentSpec[]> => request(`/api/agents${archived ? "?archived=1" : ""}`),

  /** Make an agent (any id not in use) or change one (its own id). */
  saveAgent: (id: string, input: AgentInput): Promise<AgentSpec> =>
    request(`/api/agents/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),

  archiveAgent: (id: string): Promise<AgentSpec> =>
    request(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),

  restoreAgent: (id: string): Promise<AgentSpec> =>
    request(`/api/agents/${encodeURIComponent(id)}/restore`, { method: "POST" }),

  /** The Generate button: a draft of one part of an agent, from what was typed. Nothing is saved. */
  assistAgent: (input: {
    field: "role" | "instructions" | "personality" | "knowledge";
    text: string;
    agent: { name?: string; role?: string };
  }): Promise<{ text: string }> => request("/api/agents/assist", json(input)),

  sharedKnowledge: (): Promise<SharedAgentKnowledge> => request("/api/agent-knowledge"),

  saveSharedKnowledge: (knowledge: Pick<SharedAgentKnowledge, "notes" | "context">): Promise<SharedAgentKnowledge> =>
    request("/api/agent-knowledge", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(knowledge),
    }),

  /* ── workflows ─────────────────────────────────────────────────────── */

  workflows: (startableByAgent = false): Promise<WorkflowSpec[]> =>
    request(`/api/workflows${startableByAgent ? "?startableBy=agent" : ""}`),

  /** Make a workflow (any id not in use) or change one (its own id). Saving makes you the person it runs as. */
  saveWorkflow: (id: string, input: WorkflowInput): Promise<WorkflowSpec> =>
    request(`/api/workflows/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),

  setWorkflowEnabled: (id: string, enabled: boolean): Promise<WorkflowSpec> =>
    request(`/api/workflows/${encodeURIComponent(id)}/enabled`, json({ enabled })),

  deleteWorkflow: (id: string): Promise<{ removed: true }> =>
    request(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" }),

  runWorkflow: (id: string, inputs: Record<string, unknown> = {}): Promise<WorkflowRun> =>
    request(`/api/workflows/${encodeURIComponent(id)}/run`, json({ inputs })),

  /** A dry run of a saved workflow, or of an unsaved draft: what it reads, what matches, and each row's path. */
  previewWorkflow: (id: string, draft?: WorkflowInput, inputs: Record<string, unknown> = {}): Promise<WorkflowPreview> =>
    request(`/api/workflows/${encodeURIComponent(id)}/preview`, json({ ...(draft ? { workflow: draft } : {}), inputs })),

  workflowRuns: (id?: string): Promise<WorkflowRun[]> =>
    request(id ? `/api/workflows/${encodeURIComponent(id)}/runs` : "/api/workflow-runs"),

  /** A draft explained: what is missing, what to suggest, the one-sentence summary. Nothing is saved. */
  checkWorkflow: (id: string, draft: WorkflowInput): Promise<WorkflowCheck> => request(`/api/workflows/${encodeURIComponent(id)}/check`, json({ workflow: draft })),

  workflowCases: (id: string): Promise<WorkflowCase[]> => request(`/api/workflows/${encodeURIComponent(id)}/cases`),

  workflowCase: (id: string): Promise<WorkflowCase & { tasks: Task[] }> => request(`/api/cases/${encodeURIComponent(id)}`),

  cancelCase: (id: string): Promise<WorkflowCase> => request(`/api/cases/${encodeURIComponent(id)}/cancel`, json({})),

  tasks: (filter: { status?: TaskStatus; workflow?: string; case?: string; limit?: number } = {}): Promise<Task[]> => {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return request(`/api/tasks${query.size > 0 ? `?${query}` : ""}`);
  },

  /** Open a task waiting for approval: a change is prepared now, as you. */
  reviewTask: (id: string): Promise<{ task: Task; review?: WriteReviewView; stale?: string }> => request(`/api/tasks/${encodeURIComponent(id)}/review`, json({})),

  approveTask: (id: string, approval: { pendingId?: string; digest?: string; always?: boolean } = {}): Promise<{ task: Task; case?: WorkflowCase }> =>
    request(`/api/tasks/${encodeURIComponent(id)}/approve`, json(approval)),

  declineTask: (id: string): Promise<Task> => request(`/api/tasks/${encodeURIComponent(id)}/decline`, json({})),
  /** It happened: a send Dash was not sure of is marked done, and not sent again. */
  settleTask: (id: string): Promise<Task> => request(`/api/tasks/${encodeURIComponent(id)}/settle`, json({})),

  answerTask: (id: string, answer: string): Promise<Task> => request(`/api/tasks/${encodeURIComponent(id)}/answer`, json({ answer })),

  completeTask: (id: string): Promise<Task> => request(`/api/tasks/${encodeURIComponent(id)}/complete`, json({})),

  reverseReview: (id: string): Promise<{ task: Task; review?: WriteReviewView; stale?: string }> => request(`/api/tasks/${encodeURIComponent(id)}/reverse-review`, json({})),

  reverseTask: (id: string, approval: { pendingId?: string; digest?: string } = {}): Promise<{ task: Task; reversal: Task }> =>
    request(`/api/tasks/${encodeURIComponent(id)}/reverse`, json(approval)),

  templates: (): Promise<WorkflowTemplate[]> => request("/api/workflow-templates"),

  saveTemplate: (input: { workflow: string; kind: "step" | "path" | "workflow"; name: string; steps?: string[]; description?: string }): Promise<WorkflowTemplate> =>
    request("/api/workflow-templates", json(input)),

  deleteTemplate: (id: string): Promise<{ removed: true }> => request(`/api/workflow-templates/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** A template's steps with its blanks filled, ready to add to the canvas. Nothing is saved. */
  insertTemplate: (id: string, values: Record<string, string>, at: { x: number; y: number }): Promise<{ nodes: WorkflowInput["nodes"]; edges: WorkflowInput["edges"]; entry?: string; template: WorkflowTemplate }> =>
    request(`/api/workflow-templates/${encodeURIComponent(id)}/insert`, json({ values, at })),

  workflowFromTemplate: (id: string, values: Record<string, string>, name?: string): Promise<WorkflowSpec> =>
    request(`/api/workflow-templates/${encodeURIComponent(id)}/workflow`, json({ values, ...(name ? { name } : {}) })),

  /* ── calendar ──────────────────────────────────────────────────────── */

  /** Entries overlapping [from, to), with optional owner (`agent:<id>`, `member:<id>`), kind and status filters. */
  calendar: (filter: { from?: string; to?: string; owners?: readonly string[]; kinds?: readonly string[]; statuses?: readonly string[] } = {}): Promise<CalendarEvent[]> => {
    const query = new URLSearchParams();
    if (filter.from) query.set("from", filter.from);
    if (filter.to) query.set("to", filter.to);
    if (filter.owners && filter.owners.length > 0) query.set("owner", filter.owners.join(","));
    if (filter.kinds && filter.kinds.length > 0) query.set("kind", filter.kinds.join(","));
    if (filter.statuses && filter.statuses.length > 0) query.set("status", filter.statuses.join(","));
    return request(`/api/calendar${query.size > 0 ? `?${query}` : ""}`);
  },
  calendarEntry: (id: string): Promise<CalendarEvent> => request(`/api/calendar/${encodeURIComponent(id)}`),
  addCalendarEntry: (input: CalendarEntryInput): Promise<CalendarEvent> => request("/api/calendar", json(input)),
  /** Change an entry. Sending `end` or `notes` empty clears it. */
  updateCalendarEntry: (id: string, input: Partial<CalendarEntryInput>): Promise<CalendarEvent> =>
    request(`/api/calendar/${encodeURIComponent(id)}`, { ...json(input), method: "PUT" }),
  setCalendarStatus: (id: string, status: "open" | "done" | "cancelled"): Promise<CalendarEvent> =>
    request(`/api/calendar/${encodeURIComponent(id)}/status`, json({ status })),
  removeCalendarEntry: (id: string): Promise<{ removed: true; id: string }> =>
    request(`/api/calendar/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /* ── scheduling ────────────────────────────────────────────────────── */

  scheduling: (): Promise<SchedulingOverview> => request("/api/scheduling"),
  schedulingDefaults: (settings: PartialSettings): Promise<PartialSettings> => request("/api/scheduling/defaults", { ...json(settings), method: "PUT" }),
  putProfile: (member: string, profile: Partial<SchedulingProfile>): Promise<SchedulingProfile> =>
    request(`/api/scheduling/profiles/${encodeURIComponent(member)}`, { ...json(profile), method: "PUT" }),
  removeProfile: (member: string): Promise<{ removed: true }> => request(`/api/scheduling/profiles/${encodeURIComponent(member)}`, { method: "DELETE" }),
  putPool: (id: string, pool: Partial<Pool>): Promise<Pool> => request(`/api/scheduling/pools/${encodeURIComponent(id)}`, { ...json(pool), method: "PUT" }),
  removePool: (id: string): Promise<{ removed: true }> => request(`/api/scheduling/pools/${encodeURIComponent(id)}`, { method: "DELETE" }),
  putType: (id: string, type: Partial<AppointmentType>): Promise<AppointmentType> => request(`/api/scheduling/types/${encodeURIComponent(id)}`, { ...json(type), method: "PUT" }),
  removeType: (id: string): Promise<{ removed: true }> => request(`/api/scheduling/types/${encodeURIComponent(id)}`, { method: "DELETE" }),
  previewType: (id: string, input: { from?: string; to?: string; contact?: Record<string, unknown>; contactId?: string; request?: Record<string, unknown>; all?: boolean }): Promise<SlotPreview> =>
    request(`/api/scheduling/types/${encodeURIComponent(id)}/preview`, json(input)),
  putBlock: (id: string, block: Partial<Block>): Promise<Block> => request(`/api/scheduling/blocks/${encodeURIComponent(id)}`, { ...json(block), method: "PUT" }),
  removeBlock: (id: string): Promise<{ removed: true }> => request(`/api/scheduling/blocks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  putPlacement: (id: string, placement: Partial<Placement>): Promise<Placement> => request(`/api/scheduling/placements/${encodeURIComponent(id)}`, { ...json(placement), method: "PUT" }),
  removePlacement: (id: string): Promise<{ removed: true }> => request(`/api/scheduling/placements/${encodeURIComponent(id)}`, { method: "DELETE" }),
  skipOccurrence: (id: string, date: string): Promise<Placement> => request(`/api/scheduling/placements/${encodeURIComponent(id)}/skip`, json({ date })),
  splitPlacement: (id: string, date: string, newId: string): Promise<{ before: Placement; after: Placement }> =>
    request(`/api/scheduling/placements/${encodeURIComponent(id)}/split`, json({ date, newId })),
  occurrences: (from: string, to: string): Promise<HostOccurrence[]> => request(`/api/scheduling/occurrences?${new URLSearchParams({ from, to })}`),

  /* ── bookings ──────────────────────────────────────────────────────── */

  bookings: (query: { from?: string; to?: string; host?: string; contact?: string; status?: readonly BookingStatus[] } = {}): Promise<Booking[]> =>
    request(
      `/api/scheduling/bookings?${new URLSearchParams({
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        ...(query.host ? { host: query.host } : {}),
        ...(query.contact ? { contact: query.contact } : {}),
        ...(query.status && query.status.length > 0 ? { status: query.status.join(",") } : {}),
      }).toString()}`,
    ),
  booking: (id: string): Promise<Booking> => request(`/api/scheduling/bookings/${encodeURIComponent(id)}`),
  /** A member books for a contact. A taken time answers 409 with open times nearby as `detail.slots`. */
  createBooking: (input: { type: string; contact: string; start: string; host?: string; approval?: "always" }): Promise<{ booking: Booking; outcome: "pending" | "confirmed" }> =>
    request("/api/scheduling/bookings", json(input)),
  confirmBooking: (id: string, message?: string): Promise<Booking> => request(`/api/scheduling/bookings/${encodeURIComponent(id)}/confirm`, json(message ? { message } : {})),
  suggestBooking: (id: string, input: { times: Array<{ start: string; host?: string }>; message?: string; reason?: string; allowOutside?: boolean }): Promise<Booking> =>
    request(`/api/scheduling/bookings/${encodeURIComponent(id)}/suggest`, json(input)),
  denyBooking: (id: string, input: { reason?: string; message?: string }): Promise<Booking> => request(`/api/scheduling/bookings/${encodeURIComponent(id)}/deny`, json(input)),
  cancelBooking: (id: string, reason?: string): Promise<Booking> => request(`/api/scheduling/bookings/${encodeURIComponent(id)}/cancel`, json(reason ? { reason } : {})),
  moveBooking: (id: string, start: string, host?: string): Promise<Booking> => request(`/api/scheduling/bookings/${encodeURIComponent(id)}/move`, json({ start, ...(host ? { host } : {}) })),
  assignBooking: (id: string, host?: string): Promise<Booking> => request(`/api/scheduling/bookings/${encodeURIComponent(id)}/assign`, json(host ? { host } : {})),
  markBooking: (id: string, as: "completed" | "no_show"): Promise<Booking> => request(`/api/scheduling/bookings/${encodeURIComponent(id)}/mark`, json({ as })),
  bookingSlots: (type: string, contact: string, from: string, to: string): Promise<SlotPreview> =>
    request(`/api/scheduling/slots?${new URLSearchParams({ type, contact, from, to }).toString()}`),
  /** Your own link to answer this booking's waiting approval from the approval page. */
  approvalLink: (id: string): Promise<{ url: string; expiresAt: string }> => request(`/api/scheduling/bookings/${encodeURIComponent(id)}/approval-link`, json({})),
  /** The person's own page for this booking. */
  bookingPageLink: (id: string): Promise<{ url: string }> => request(`/api/scheduling/bookings/${encodeURIComponent(id)}/link`, json({})),

  /* ── contacts ──────────────────────────────────────────────────────── */

  contacts: (query: { search?: string; limit?: number; after?: string } = {}): Promise<{ contacts: Contact[]; next?: string }> =>
    request(
      `/api/contacts?${new URLSearchParams({
        ...(query.search ? { search: query.search } : {}),
        ...(query.limit ? { limit: String(query.limit) } : {}),
        ...(query.after ? { after: query.after } : {}),
      }).toString()}`,
    ),
  contact: (id: string): Promise<Contact> => request(`/api/contacts/${encodeURIComponent(id)}`),
  /** A 409 carries the contact that already has the email or phone, as `detail.holder`. */
  createContact: (input: ContactInput): Promise<Contact> => request("/api/contacts", json(input)),
  updateContact: (id: string, input: ContactInput): Promise<Contact> => request(`/api/contacts/${encodeURIComponent(id)}`, { ...json(input), method: "PUT" }),
  forgetContact: (id: string): Promise<{ ok: true }> => request(`/api/contacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  matchContact: (id: string): Promise<{ outcome: MatchOutcome; contact: Contact }> => request(`/api/contacts/${encodeURIComponent(id)}/match`, json({})),
  refreshContact: (id: string): Promise<{ contact: Contact; problems: string[] }> => request(`/api/contacts/${encodeURIComponent(id)}/refresh`, json({})),
  linkContact: (id: string, target: RecordTarget): Promise<{ contact: Contact; problems: string[] }> => request(`/api/contacts/${encodeURIComponent(id)}/link`, json(target)),
  unlinkContact: (id: string, target: RecordTarget): Promise<Contact> => request(`/api/contacts/${encodeURIComponent(id)}/unlink`, json(target)),
  /** A contact's booking links: never the link itself, which is shown once when made. */
  contactLinks: (id: string): Promise<BookingLinkInfo[]> => request(`/api/contacts/${encodeURIComponent(id)}/links`),
  makeContactLink: (id: string, type?: string): Promise<{ url: string; link: BookingLinkInfo }> => request(`/api/contacts/${encodeURIComponent(id)}/links`, json(type ? { type } : {})),
  revokeContactLink: (id: string, link: string): Promise<BookingLinkInfo> => request(`/api/contacts/${encodeURIComponent(id)}/links/${encodeURIComponent(link)}/revoke`, json({})),
  contactSetup: (): Promise<ContactSetup> => request("/api/contacts/setup"),
  contactSources: (): Promise<ContactSource[]> => request("/api/contacts/sources"),
  putContactField: (key: string, input: ContactFieldDefInput): Promise<ContactFieldDef> =>
    request(`/api/contacts/fields/${encodeURIComponent(key)}`, { ...json(input), method: "PUT" }),
  removeContactField: (key: string): Promise<{ ok: true }> => request(`/api/contacts/fields/${encodeURIComponent(key)}`, { method: "DELETE" }),
  putMatchRule: (id: string | null, input: ContactMatchRuleInput): Promise<ContactMatchRule> =>
    id ? request(`/api/contacts/match-rules/${encodeURIComponent(id)}`, { ...json(input), method: "PUT" }) : request("/api/contacts/match-rules", json(input)),
  removeMatchRule: (id: string): Promise<{ ok: true }> => request(`/api/contacts/match-rules/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Who this browser is talking as. */
  me: (): Promise<{ principal: Principal | null; mode: "local" | "managed" }> => request("/api/me"),

  /** The Agent side's Overview: active workflows and completed tasks. */
  overview: (): Promise<AgentOverview> => request("/api/overview"),

  /**
   * Connect a catalog API. Marked for onboarding, so it opens with the boards
   * chosen at the end of the wizard rather than an empty one first.
   */
  createFromCatalog: (input: {
    catalogId: string;
    id?: string;
    opIds?: string[];
  }): Promise<ConnectionSummary & { needsKey: boolean; needsAddress?: boolean }> =>
    request("/api/connections/from-catalog", json({ ...input, onboarding: true })),

  /**
   * Say where a connection's API lives: the values for its address's blanks,
   * or the whole address when the documentation never said. A new address is
   * treated like a new key — cached rows from the old one are dropped.
   */
  setAddress: (
    connectionId: string,
    input: ({ values: Record<string, string> } | { baseUrl: string }) & { privateNetwork?: boolean },
  ): Promise<ConnectionSummary> =>
    request(`/api/connections/${connectionId}/address`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),

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

  availableOps: (
    id: string,
  ): Promise<Array<{ id: string; title: string; path: string; archetype: string }>> =>
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
  }> => request(`/api/connections/${id}/validate`, json({})),

  sample: (id: string, op: string): Promise<SampleResult> =>
    request(`/api/connections/${id}/sample`, json({ op })),

  /**
   * What a widget on a board could be changed to, and changing it.
   *
   * Derived on the server because it needs the record type, the reach graph
   * and the compiler — none of which the browser has — and because answering a
   * control must have exactly one implementation.
   */
  widgetSettings: (dashboardId: string, widgetId: string): Promise<WidgetSettings> =>
    request(`/api/dashboards/${dashboardId}/widgets/${widgetId}/settings`),

  answerWidget: (
    dashboardId: string,
    widgetId: string,
    stepId: string,
    values: readonly string[],
  ): Promise<{ widget: WidgetSpec; notes: string[]; controls: ConciergeControl[] }> =>
    request(`/api/dashboards/${dashboardId}/widgets/${widgetId}/brief`, {
      ...json({ stepId, values }),
      method: "PUT",
    }),

  /** A POST because it samples the API for real. Changes nothing. */
  capabilities: (id: string, refresh = false, deep = false): Promise<Capabilities> =>
    request(`/api/connections/${id}/capabilities`, json({ refresh, deep })),

  /** Costs nothing: everything in the answer is read off the endpoints. */
  enumerationPlan: (id: string, deep = false): Promise<EnumerationPlan> =>
    request(`/api/connections/${id}/enumeration-plan${deep ? "?deep=true" : ""}`),

  /** Free: reads the stored report, or the endpoint graph when there is none. */
  relations: (id: string): Promise<RelationsResult> => request(`/api/connections/${id}/relations`),

  /** The approval step: the proposal above, accepted onto the connection. */
  setResources: (id: string, resources: ResourceSpec[]): Promise<ConnectionSummary> =>
    request(`/api/connections/${id}/resources`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resources }),
    }),
  /** Which topic the next message belongs in, decided before it is sent. */
  chatRoute: (body: { text: string; topicId?: string; viewing?: string }): Promise<{ topicId: string; name: string; isNew: boolean }> =>
    request("/api/chat/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, tz: timeZone() }),
    }),

  /** Days with talk or finished work, newest first. */
  chatDays: (before?: string, limit?: number): Promise<{ today: string; days: ChatDaySummary[]; more: boolean }> =>
    request(
      `/api/chat/days?${new URLSearchParams({
        tz: timeZone(),
        ...(before ? { before } : {}),
        ...(limit ? { limit: String(limit) } : {}),
      }).toString()}`,
    ),

  /** One day's topics and finished work. */
  chatDay: (day: string): Promise<{ day: string; topics: ChatTopic[]; tasks: ChatTimelineTask[] }> =>
    request(`/api/chat/day/${encodeURIComponent(day)}?${new URLSearchParams({ tz: timeZone() }).toString()}`),

  /** Every message on one day (today when no day is given). */
  chatMessages: (day?: string): Promise<ChatDayMessages> =>
    request(`/api/chat/messages?${new URLSearchParams({ tz: timeZone(), ...(day ? { day } : {}) }).toString()}`),
};
