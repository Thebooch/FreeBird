import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  AdapterError,
  RestAdapter,
  type HttpFetch,
} from "@freebirdai/dash-adapters";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type {
  Arrangement,
  ConciergeContext,
  ConciergeDraft,
  DraftPatch,
  InferredShape,
} from "@freebirdai/dash-agent";
import {
  briefCandidates,
  resolveCandidate,
  inferShape,
  patchFromBrief,
  widgetId,
  writeBrief,
} from "@freebirdai/dash-agent";
import type {
  ConnectionSpec,
  DashboardSpec,
  EntityLinkView,
  EntitySpec,
  RangePreset,
  ResolvedParams,
  TimeRange,
  WidgetBrief,
} from "@freebirdai/dash-spec";
import {
  catalogEntrySchema,
  connectionKeyRefs,
  connectionNeedsAuthSetup,
  connectionSchema,
  dashboardSchema,
  defaultGrainFor,
  findNarrowing,
  getOp,
  isStale,
  opDefSchema,
  onboardingSchema,
  opUsesRange,
  pathParamNames,
  resolveRange,
  resourceSchema,
  statusTone,
} from "@freebirdai/dash-spec";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { createFreeBirdPlugin } from "@freebirdai/server/fastify";
import {
  type AnalyseOptions,
  type SampleFn,
  analyseConnection,
  analyseStructure,
  estimateEnumeration,
  fromReport,
  toReport,
  withVerifiedParams,
} from "./capabilities.js";
import type { ChatDb } from "./chat/db.js";
import { resolveChatLlm } from "./chat/llm-bridge.js";
import { LOOK_UP_TOOL, lookUpEndpoint, lookUpSchema } from "./chat/concierge-actions.js";
import { buildChatRegistry } from "./chat/registry.js";
import { buildConciergeContext } from "./concierge/context.js";
import { rearrangeSetup } from "./concierge/arrange.js";
import { planDetailSetup } from "./concierge/detail.js";
import type { DetailPlanRequest, DetailSetup } from "./concierge/detail.js";
import { planNarrowing } from "./concierge/drilldown.js";
import { NarrowingStore } from "./narrowings.js";
import { MemoryDraftStore, ScratchDraftStore, type DraftStore } from "./concierge/store.js";
import { CatalogStore, connectionFromCatalog, refreshCatalogConnection } from "./catalog.js";
import { discover, readIndex } from "./discovery/index.js";
import type { SearchProvider } from "./discovery/search.js";
import {
  type ModelChoices,
  availableProviders,
  defaultModelId,
  enterTurnBudget,
  llmSpend,
  modelForTask,
  preferredProvider,
  sourceForTask,
  turnCeilingUsd,
} from "./llm.js";
import {
  type LlmTask,
  MODELS,
  PROVIDERS,
  TASKS,
  type TaskInfo,
  findProvider,
  findTask,
  isProvider,
  isTask,
  providerFor,
} from "./models.js";
import { RATES_AS_OF } from "./pricing.js";
import { BlockedUrlError, fetchPublicDocument, guardedFetch } from "./safe-fetch.js";
import type { PartRegistry } from "@freebirdai/dash-parts";
import { partsRoutes } from "./routes/parts.js";
import { conciergeRoutes } from "./routes/concierge.js";
import { SetupPreviews } from "./concierge/preview.js";
import { contextForConnection } from "@freebirdai/dash-agent";
import { migrateCredentialRefs } from "./credential-migration.js";
import {
  answerBrief,
  briefOptions,
  compileBrief,
  entityById,
  entityGraph,
  parseDashboard,
  recompileWidget,
  entityLinkViews,
  entityPageView,
  fieldLexicon,
  fieldGroupSchema,
  fieldPathSchema,
  fingerprintConnection,
  recipeFor,
  widgetBriefSchema,
} from "@freebirdai/dash-spec";
import { mapRoutes, mergeDescribedEntities } from "./routes/map.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { allocateDashboardId } from "./onboarding/materialise.js";
import { DEFAULT_EVERY_MS, Keeper, LastSeen } from "./keeper/keeper.js";
import { decideAll, opsOfResource } from "./keeper/rhythm.js";
import { RhythmStore } from "./rhythm-store.js";
import { warmTargets } from "./keeper/targets.js";
import { ViewedRequests, paramShape } from "./keeper/viewed.js";
import { VERIFY_BUDGET_DEFAULT, VERIFY_BUDGET_MAX, verifyRecords } from "./routes/verify.js";
import type { Settings, SettingsStore } from "./settings.js";
import { QueryCache, clampMaxAge } from "./cache/queryCache.js";
import { extractRows, parsePath } from "@freebirdai/dash-expr";
import { catalogEntryToVerify, validationCandidates } from "./verified.js";
import { buildQueryRequest, resolveRequestedRange } from "./query.js";
import { ANSWER_TOOL, answerFromData } from "./context/tool.js";
import { bindingFor, bindingsFor } from "./tools/bindings.js";
import { READ_TOOL, READ_TOOL_NAME, readRecords, readToolSchema } from "./tools/read.js";
import { queryRoster, readRoster } from "./tools/roster.js";
import type { ToolDeps } from "./tools/types.js";
import { QUERY_TOOL, QUERY_TOOL_NAME, queryRecords, queryToolSchema } from "./tools/query.js";
import { WRITE_TOOL, WRITE_TOOL_NAME, planWrite, writeToolSchema } from "./tools/write.js";
import type { ReadOutcome } from "./context/types.js";
import { workspaceHandles } from "./chat/handles.js";
import { createPromptRotation, renderDashReply } from "./chat/respond.js";
import { ScratchFocusStore } from "./context/focus.js";
import {
  describeFilters,
  describeScreen,
  focusFromScreen,
  parseFilters,
  parseView,
} from "./context/onscreen.js";
import { LOOK_UP_WIDGET_TOOL, lookUpWidget, lookUpWidgetSchema } from "./chat/lookUpWidget.js";
import type { CacheStore } from "./cache/store.js";
import { coolingMessage, retryAfterSeconds, waitPhrase } from "./cache/cooldown.js";
import { ConnectionGate, Priority } from "./cache/gate.js";
import { SpecStore } from "./store.js";
import { GrantStore, approveWidget, dashboardApprovals, widgetGrantSubject } from "./grants.js";
import { KeyStore } from "./vault.js";

export interface BuildServerOptions {
  readonly store: SpecStore;
  readonly keys: KeyStore;
  readonly catalog?: CatalogStore;
  /**
   * Which saved widgets a person has approved.
   *
   * Absent means no approval gate at all, which is what every existing
   * deployment and test gets until it opts in by supplying a store.
   */
  readonly grants?: GrantStore;
  /**
   * Where confirmed narrowings are kept, per connection.
   *
   * Absent means a drill-down still works and simply asks again next time —
   * the answers are a cache of the user's own confirmations, not a dependency.
   */
  readonly narrowings?: NarrowingStore;
  /**
   * How often each endpoint is asked again, per connection.
   *
   * Absent means a scratch directory, which is right for a test: the shipped
   * cadences apply and nothing anybody ticks outlives the run.
   */
  readonly rhythms?: RhythmStore;
  /** Test seam: swap the transport without touching the routes. */
  readonly http?: HttpFetch;
  /**
   * Absent means no AI key is configured; the route says so plainly.
   *
   * A function is resolved per request, so changing the selected model takes
   * effect immediately instead of at the next restart. Tests pass a static
   * adapter, which behaves exactly as before.
   */
  readonly llm?: LlmAdapter | null | ((label?: string) => LlmAdapter | null);
  /** Absent means the search rung is simply not available. */
  readonly search?: SearchProvider | null | (() => SearchProvider | null);
  /** Model selection for the picker. Absent means the routes are not exposed. */
  readonly settings?: SettingsStore;
  /** Swappable units. Absent means the parts routes are not exposed. */
  readonly parts?: PartRegistry;
  /**
   * Chat storage. Absent means the chat routes are not mounted at all.
   *
   * Opened by the caller rather than here because it is async and
   * `buildServer` is not — and because a test that does not exercise chat
   * should not pay to start a database.
   */
  readonly chat?: ChatDb;
  readonly logger?: boolean;
  /**
   * Whether the keeper runs. **Off unless asked.**
   *
   * The safe direction: this suite builds servers by the hundred, and a
   * default that gave each one a timer and a background appetite for
   * somebody's API would mean a test could spend real quota by existing. The
   * real entry point turns it on deliberately.
   */
  readonly keeper?: boolean;
  /**
   * Where cached responses live. Omitted means in this process only, which
   * is the right default for a self-hoster and the wrong one for a fleet.
   */
  readonly cache?: CacheStore;
}

/**
 * Who a local instance runs as.
 *
 * Never blank: the chat adapter drops its owner filter for a falsy user id,
 * so an empty identity would make every session readable by every caller the
 * moment this stops being single-user.
 */
export const LOCAL_USER_ID = "local";

/** Exported so the prompt-budget driver can measure it. */
export const CHAT_SYSTEM_PROMPT = [
  "You are the assistant inside FreeBird Dash, a dashboard over the user's own APIs.",
  "",
  "You are always given the whole workspace. The knowledge for the component named",
  'after the dashboard carries "WIDGETS" — every widget that exists, on every tab,',
  "grouped by tab. That is the complete list; there is no other widget you have not",
  "been told about. Match the user's wording against these titles rather than asking",
  "for an id, and never ask them to switch tabs first — tabs are how they filed",
  "things, not a limit on what you can talk about. `open_widget` moves the view.",
  "",
  "There is no list of ready-made widgets to pick from, and that is deliberate.",
  "When somebody wants something they do not have, build exactly what they asked",
  "for — see BUILDING A WIDGET below — rather than reaching for the nearest",
  "approximation of it.",
  "",
  "Never say you cannot see the dashboard: if a widget is not in that list, it is",
  "genuinely not there. Say so, and offer to build it.",
  "",
  "THREE TOOLS, AND THE DIFFERENCE BETWEEN THEM. You are given full detail for the",
  "widgets on the tab that is open, and only names for the rest. When you need more:",
  "",
  "  - `look_up_widget` — what a widget on another tab is: its endpoint, its",
  "    fields, what one row is. Costs nothing.",
  "  - `look_up_endpoint` — what an endpoint could show. Also costs nothing.",
  "  - `answer_from_data` — what the data actually SAYS. Call this for any",
  "    question whose answer is a value: a count, a total, a maximum, a specific",
  "    record, or what a widget is currently showing. It searches the widgets on",
  "    every tab and the connected endpoints, reads a bounded sample, and reports",
  "    how much it read.",
  "",
  "GOING DEEPER. Every answer says how much it read, and the reply carries a",
  '"dig deeper" offer when it read only part of a source. When the user takes it,',
  "first tell them the options — a number of records, back to a date, or everything —",
  "and what each would cost in requests; everything is usually a lot. Once they choose,",
  "call `answer_from_data` again with `scanRecords` set. That reads the records in chunks",
  "and reports patterns nobody asked about alongside the answer, which is the point of it.",
  "Never set `scanRecords` on your own initiative: it spends their money to be thorough",
  "about a question they asked casually.",
  "",
  "FOLLOW-UPS. `answer_from_data` remembers the records the last question was about, so",
  '"what was the issue?", "when is it due?" and "any notes on it?" go back to it rather',
  "than being left unanswered. It answers from what it already holds when it can, and",
  "opens what is attached to a record when it has to - saying what that cost.",
  "",
  "ANSWER AND SHOW. Sending somebody to the right place is genuinely useful - a lot of",
  "people would rather look at a widget and click around than read a paragraph - so keep",
  "doing it. What is not acceptable is offering it *instead* of the answer. Say what the",
  "data says first, then take them to it: `open_widget` moves the view, and citing a",
  "widget puts a chip under your reply that goes straight to the tile. Never say you",
  "cannot see something and point at the screen in its place; look it up, answer, and",
  "then point.",
  "",
  "Never answer a question about values from memory or from field names. If you did",
  "not call `answer_from_data`, you do not know what the data says — and a number",
  "you guessed renders exactly like one you read. When it reports that it only saw",
  "part of a source, say so alongside the number rather than presenting a sample as",
  "a total.",
  "",
  "Two more lists sit alongside them, and they answer the questions the widget",
  "lists cannot:",
  "",
  '  - "TABS" — every dashboard that exists, and which one is current. Answer',
  '    "what tabs do I have?" from it, and use `switch_dashboard` to move.',
  '  - "CONNECTIONS" — every attached API and whether it has been read. An',
  "    unread connection is the reason it has no widgets to offer; say that",
  "    plainly instead of guessing around it.",
  "",
  "Per-widget knowledge adds the detail: which endpoint a widget reads, what one",
  "row represents, which fields exist, and whether an endpoint could not be read.",
  "",
  "You can change things by calling actions: add or remove a widget, create,",
  "rename, switch or delete a tab, change the time range, open a widget. Anything",
  "that changes what is stored shows a confirmation card first — deleting a tab",
  "asks twice, because it takes its widgets with it and cannot be undone. Do not",
  "claim a change has happened until it actually has.",
  "",
  "Two things you open rather than do: `open_connections` and `open_add_widget`",
  "put the user in front of a panel. Attaching an API needs a credential and a",
  "decision about cost, which is theirs. `read_connection` is the same — it opens",
  "the panel that shows how many requests reading will make; it never reads on",
  "its own.",
  "",
  "BUILDING A WIDGET is the one thing you do at length, and it is a conversation",
  "rather than a form. `start_setup` opens it; from then on the knowledge names",
  "every endpoint, field and view you may choose from, and `revise_setup` sets",
  "any of them — several at once.",
  "",
  "One call builds it. `start_setup` takes their words AND the whole proposal —",
  "endpoint, view, a `title`, and the field for each role — from the ENDPOINTS",
  "and VIEWS lists you are given. Never call it with only an intent: that leaves",
  "them picking from a list of endpoints, which is exactly what this replaces.",
  "",
  "Say what you made, in the same reply, in one sentence — they are looking at",
  "it, so describe it rather than announcing it. Never say you are starting, or",
  "that you will let them know when it is done: by the time they read your",
  "reply the preview is already on screen.",
  "",
  "Three rules, and they are the whole difference between this and a wizard:",
  "",
  "  - Ask in their language, about what they want to see. Never read a list of",
  "    field names back to them and ask which one; you have the list precisely so",
  "    they do not have to. Keep asking until you have a clear picture — often",
  "    their first sentence is already enough, and then you should just build it.",
  "  - Propose the whole widget at once, then let them adjust. They are looking at",
  "    a live preview of it, not a description, so 'make it a chart' or 'add the",
  "    rent' is another `revise_setup` and they see the result immediately.",
  "  - Never invent a field name to avoid asking. Anything outside the lists is",
  "    rejected and handed back to you, and a binding that looks right but is not",
  "    is worse than one more question.",
  "",
  "ASKING A QUESTION. `ask_user` puts two or three plain options in front of them",
  "and waits. It is for a real fork, where the readings lead to different widgets",
  "and guessing wrong wastes their time:",
  "",
  "  - the records themselves, or a count of them — a list and a chart are not",
  "    variations on one answer;",
  "  - a narrowing phrase that matches nothing in their data.",
  "",
  "Two record types their words fit equally well is NOT one of them, however",
  "even the choice looks. That fork is settled where the widget is decided, and",
  "the reading you did not take is offered back as one click — so asking about",
  "it here would be asking a question that has already been answered twice.",
  "",
  "Everything else you decide. Never ask which field to bind to a role, how to",
  "sort, or what to call it — those have sensible answers and they can change any",
  "of them by saying so once it is on screen. At most two questions before you",
  "build something; past that, build it and let them adjust. Put the option you",
  "would have chosen first, and phrase all of them in their language rather than",
  "the API's.",
  "",
  "Never invent an id. Keep answers short and concrete.",
].join("\n");

/**
 * The real transport, wrapped in the SSRF guard and the host allowlist.
 *
 * Exported so a driver script reads through exactly the transport the server
 * does. A second, unguarded copy in a script is how an SSRF guard stops being
 * true of every path that reaches an API.
 */
export const nodeHttp: HttpFetch = async (url, init, allowedHost) => {
  const result = await guardedFetch(url, init, allowedHost);
  return {
    status: result.status,
    text: result.text,
    url: result.url,
    header: (name) => result.headers.get(name),
  };
};

const rangeSchema = z.object({
  preset: z.enum(["1h", "24h", "7d", "30d", "90d", "12mo", "ytd", "custom"]).default("30d"),
  grain: z.enum(["1h", "1d", "1w", "1mo", "1y"]).optional(),
  start: z.number().optional(),
  end: z.number().optional(),
});

const querySchema = z.object({
  connection: z.string().min(1),
  op: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  range: rangeSchema.default({ preset: "30d" }),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /**
   * How old an answer this caller will accept, in milliseconds.
   *
   * Stated per request rather than configured server-side, because one
   * endpoint is read by several widgets that legitimately disagree about how
   * current they need to be. Zero means revalidate, which is what an explicit
   * Refresh sends. Clamped before use.
   */
  maxAgeMs: z.number().optional(),
  /**
   * Whether somebody is looking, or somebody asked.
   *
   * `view` is what a board sends while it is being read: serve what is held,
   * at any age, and never call the API. `refresh` is what the Refresh buttons
   * send. See `QueryCache.read`.
   *
   * Defaults to `refresh`, so an older browser, a script, or anything else
   * that does not know about this keeps exactly the behaviour it had.
   */
  mode: z.enum(["view", "refresh"]).default("refresh"),
});

/**
 * A pacing number from the environment, or the default.
 *
 * Non-numeric and negative values fall back rather than throwing: a typo in a
 * deployment's environment should not stop the server, and every value here
 * has a sane answer without it. Zero is legal and means "no limit".
 */
const pacingEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const buildServer = (options: BuildServerOptions): FastifyInstance => {
  const { store, keys } = options;
  migrateCredentialRefs(store, keys);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_000_000 });

  /*
   * Every request gets a spend ceiling.
   *
   * Each mechanism that reaches for a model is already bounded on its own —
   * the harness at four sources, a deep read at twenty chunks, a page at fifty
   * rows — but one request can reach several of them in sequence and nothing
   * bounded the total. `llm.ts` has the meter that sees every call; this is
   * what gives it something to enforce. See `DEFAULT_TURN_CEILING_USD` for how
   * the number was chosen and how to switch it off.
   *
   * On the hook rather than around the chat route because the authoring agent
   * and the concierge spend money too, and a limit that covers only the
   * cheapest of the three is a limit in name.
   */
  app.addHook("onRequest", async () => {
    enterTurnBudget(turnCeilingUsd());
  });

  const registry = new AdapterRegistry().register(new RestAdapter(options.http ?? nodeHttp));

  /**
   * Everything a widget reads goes through here.
   *
   * Deliberately not inside `AdapterRegistry.fetch`: sampling must be fresh by
   * definition, and enumeration already has its own three-tier cache. Wrapping
   * the registry would have quietly cached both.
   *
   * Memory-only by default. A response cache holds a customer's own records,
   * and keeping them in a process that forgets everything when it stops is
   * what makes "we read your API, we do not keep it" true for a self-hoster.
   * `options.cache` is how a hosted deployment supplies something shared.
   */
  /**
   * How hard this server is willing to lean on somebody else's API.
   *
   * The defaults are deliberately modest. Nothing limited concurrency before,
   * so opening a board fired every widget at once — each up to `maxPages`
   * requests, plus a fan-out of up to a hundred more — and the rate limit that
   * came back was one this server had provoked. Three at a time with a fifth
   * of a second between starts is slower on an idle API and dramatically
   * better on a metered one, because a refusal costs the whole board.
   *
   * Environment-overridable so a deployment with a generous quota is not stuck
   * with a limit chosen for a strict one.
   */
  const gate = new ConnectionGate({
    maxConcurrent: pacingEnv("DASH_MAX_CONCURRENCY", 3),
    minGapMs: pacingEnv("DASH_MIN_GAP_MS", 200),
  });

  const queries = new QueryCache({
    gate,
    ...(options.cache ? { store: options.cache } : {}),
  });

  /*
   * Who is actually looking. Read by the keeper, which refuses to spend
   * somebody's rate limit on a connection nobody has opened in a quarter of
   * an hour. See `LastSeen`.
   */
  const seen = new LastSeen();

  /*
   * What boards have actually asked for. The keeper refreshes these rather
   * than its own reconstruction of them — see `ViewedRequests`.
   */
  const viewed = new ViewedRequests();

  /**
   * How often each endpoint is asked again, per connection.
   *
   * The personal half: the cadences and anything this account moved. The
   * shared half — how often new records of each kind actually appear — is on
   * the catalog entry, written by the onboarding pass that reads the API. See
   * `keeper/rhythm.ts` for how the two meet.
   *
   * Absent means a directory of this server's own: shared across runs, a
   * cadence one test ticked would leak into the next.
   */
  const rhythms =
    options.rhythms ?? new RhythmStore(mkdtempSync(join(tmpdir(), "dash-rhythm-")));

  /** Everything needed to place one of a connection's endpoints in a tier. */
  const rhythmFor = (connection: ConnectionSpec) => {
    const entry = connection.catalog ? options.catalog?.get(connection.catalog) : undefined;
    return {
      connection,
      ...(entry?.rhythm ? { api: entry.rhythm } : {}),
      entities: entry?.entities ?? [],
      personal: rhythms.get(connection.id),
    };
  };

  /*
   * Tier decisions, remembered for a few seconds.
   *
   * Asked once per target on every tick and again for every row of the status
   * panel, and each answer reads the rhythm file and the catalog entry from
   * disk — on a synced folder, slow enough to notice. A cadence somebody just
   * moved is at most this stale, and `forgetTiers` clears it outright.
   */
  const TIER_MEMO_MS = 5_000;
  let tierMemo = { at: 0, byConnection: new Map<string, Map<string, number>>() };
  const forgetTiers = (): void => {
    tierMemo = { at: 0, byConnection: new Map() };
  };

  /**
   * How often one endpoint is asked again.
   *
   * The tier its records were placed in, or the fast one where nothing has an
   * opinion — a wrong "slow" shows day-old numbers with total confidence while
   * a wrong "fast" costs a few paced requests. A widget that asked for a
   * shorter `refresh.every` gets it: that is a stated wish, and the keeper is
   * the only thing left that asks the API on a schedule.
   */
  const everyMsForOp = (connection: string, op: string, widgetEveryMs?: number): number => {
    const now = Date.now();
    if (now - tierMemo.at > TIER_MEMO_MS) tierMemo = { at: now, byConnection: new Map() };
    let ops = tierMemo.byConnection.get(connection);
    if (!ops) {
      ops = new Map();
      const spec = store.getConnection(connection);
      if (spec) {
        for (const decision of decideAll({ ...rhythmFor(spec), ops: spec.ops.map((one) => one.id) })) {
          ops.set(decision.op, decision.everyMs);
        }
      }
      tierMemo.byConnection.set(connection, ops);
    }
    const tier = ops.get(op) ?? DEFAULT_EVERY_MS;
    return widgetEveryMs !== undefined ? Math.min(tier, widgetEveryMs) : tier;
  };

  /**
   * Every upstream call that is not a widget query.
   *
   * Verify, validate, sample, enumerate and the narrowing pass all called
   * `registry.fetch` directly, so none of them checked the cooldown, fed it,
   * or waited their turn. A verify run could therefore provoke a 429 that went
   * on to empty every tile on the board, and a connection that had just asked
   * us to stop could still be enumerated at full speed.
   *
   * Not routed through `queries.read`: these must not be cached. Sampling is
   * fresh by definition and enumeration keeps its own three-tier cache. What
   * they share with a widget query is the *connection*, which is what a rate
   * limit is a property of — so they share the gate and the breaker, and
   * nothing else.
   */
  const upstream = async <T>(connection: string, run: () => Promise<T>): Promise<T> => {
    const cooling = queries.cooldown.check(connection, Date.now());
    if (cooling)
      throw new AdapterError(`cooling down for ${connection}`, {
        status: cooling.status,
        userMessage: coolingMessage(cooling, Date.now()),
        retryAfter: retryAfterSeconds(cooling.until, Date.now()),
      });

    return gate.run(connection, Priority.Background, async () => {
      try {
        const result = await run();
        queries.cooldown.succeeded(connection);
        return result;
      } catch (error) {
        if (error instanceof AdapterError && error.status === 429) {
          queries.accounting.refused(connection);
          queries.cooldown.refused({
            connection,
            status: 429,
            retryAfter: error.retryAfter,
            reason: error.userMessage,
            now: Date.now(),
          });
        }
        throw error;
      }
    });
  };
  const previews = new SetupPreviews(queries.store, (id) => store.getConnection(id));
  const queryVersions = new Map(
    store.listConnections().map((connection) => [connection.id, fingerprintConnection(connection)]),
  );
  const refreshQueryIdentity = (connection: ConnectionSpec) => {
    const current = fingerprintConnection(connection);
    if (queryVersions.get(connection.id) !== current) {
      queries.invalidate(connection.id);
      queryVersions.set(connection.id, current);
    }
  };

  // Normalise the static and resolved forms to one shape at the edge, so no
  // route has to care which kind it was given.
  /*
   * `label` rides along so the cost line names the action that spent the
   * money — "chat" and "suggest" have very different price profiles, and a
   * single undifferentiated total cannot tell you which one to tune.
   */
  const resolveLlm = (label?: string): LlmAdapter | null =>
    typeof options.llm === "function" ? options.llm(label) : (options.llm ?? null);
  const resolveSearch = (): SearchProvider | null =>
    typeof options.search === "function" ? options.search() : (options.search ?? null);

  /**
   * Every connection gets a board of its own, named after it.
   *
   * Not a routing rule — a widget still lands on whichever board is open, and
   * a board mixing several sources is something to want later. This just means
   * there is always somewhere obvious to put a connection's widgets, and the
   * picker is enough to keep a property API and a code-hosting API apart while
   * you are working on either.
   *
   * Created empty and never touched again: if a board already exists under the
   * connection's id it is left exactly as it is, so this can run on every
   * connection write without ever overwriting anyone's work.
   */
  /**
   * The last enumeration of a connection, kept briefly.
   *
   * Enumerating is by far the most request-hungry thing here — dozens of real
   * calls against someone else's API — and both `/capabilities` and
   * `/suggestions` need the same answer. Without this, opening the drawer
   * twice doubles the load on an API that may well start refusing: a 403 where
   * an empty list used to be, which then makes everything look broken.
   *
   * Deliberately in memory and short-lived. It is an observation about a
   * moment, not a fact worth persisting, and `refresh` forces a fresh look.
   */
  const enumerated = new Map<
    string,
    {
      at: number;
      value: Awaited<ReturnType<typeof analyseConnection>>;
      shapes: Record<string, InferredShape>;
    }
  >();
  const ENUMERATION_TTL = 5 * 60_000;

  /**
   * The second-opinion pass, on whatever `suggest` routes to.
   *
   * This used to hardcode a cheap model here, because reviewing a resource map
   * is a judgement call made once per connection and running it on a frontier
   * model would cost more than the answer is worth. That reasoning is now the
   * `suggest` task's tier, so the special case has become the general rule and
   * the hardcoded id is gone. `DASH_REVIEW_MODEL` still pins it, as it always
   * did — `modelForTask` reads it as this task's env alias.
   *
   * Still resolved through `resolveLlm`, which means a test — where no provider
   * key exists — transparently gets whatever stub was injected, and never
   * reaches the network.
   */
  const llmForReview = (): LlmAdapter | null => resolveLlm("suggest");

  /**
   * One real request against one endpoint, shaped for the analyser.
   *
   * Extracted because enumeration is no longer the only caller: verifying a
   * proposed relationship reads a single child collection the same way, and
   * two implementations of "call an endpoint and describe what came back"
   * would drift on exactly the details that matter — how inputs are split, how
   * an empty 200 is classified.
   */
  const sampleFor =
    (
      connection: ReturnType<SpecStore["getConnection"]> & object,
      onShape?: (opId: string, shape: InferredShape) => void,
    ): SampleFn =>
    async (opId, inputs) => {
      const op = getOp(connection, opId);
      if (!op) return { kind: "failed", message: `no endpoint named "${opId}"` };

      /*
       * A caller's inputs are a flat bag; the endpoint knows which of them are
       * path segments and which are query values. Splitting here rather than
       * guessing is the same rule `/api/query` follows — a path token resolved
       * from the wrong bag interpolates to nothing and produces a 404 that
       * reads like a bad credential.
       */
      const declared = new Set(pathParamNames(op.path));
      const filters: Record<string, string | number | boolean> = {};
      const query: Record<string, string | number | boolean> = {};
      for (const [name, value] of Object.entries(
        (inputs ?? {}) as Record<string, string | number | boolean>,
      )) {
        if (declared.has(name)) filters[name] = value;
        else query[name] = value;
      }

      const result = await upstream(connection.id, () =>
        registry.fetch(connection.id, op.id, query, {
          params: { range: resolveRange({ preset: "30d", now: Date.now() }), filters },
          now: Date.now(),
          resolveSecret: async (keyRef) => keys.get(keyRef),
        }),
      );
      const shape = inferShape(result.body, op.rowsPath ? { rowsPath: op.rowsPath } : {});
      // A 200 with nothing in it is a fact about the account, not a failure.
      if (shape.fields.length === 0) return { kind: "empty" };
      onShape?.(op.id, shape);
      return { kind: "rows", fields: shape.fields, rowCount: shape.rowCount };
    };

  /**
   * Enumerate a connection, reusing a recent pass unless told not to.
   *
   * Three tiers, cheapest first: the in-process cache, then the report on disk,
   * then real requests. The disk tier is what makes a restart free — the report
   * describes the same endpoints (`isStale` proves it) so re-spending the
   * budget to learn what we already wrote down would be pure waste.
   */
  const enumerate = async (
    connection: ReturnType<SpecStore["getConnection"]> & object,
    refresh: boolean,
    budget: AnalyseOptions = {},
  ) => {
    const cached = enumerated.get(connection.id);
    const currentReport = store.getReport(connection.id);
    if (
      !refresh &&
      cached &&
      currentReport &&
      !isStale(currentReport, connection) &&
      Date.now() - cached.at < ENUMERATION_TTL
    )
      return cached;

    if (!refresh) {
      const stored = store.getReport(connection.id);
      if (stored && !isStale(stored, connection)) {
        const { value, shapes } = fromReport(stored);
        /*
         * A report is data written by an earlier version of this code, so it
         * is normalised on the way in rather than trusted. The case that
         * forced it: a relation carrying a filter parameter the endpoint never
         * declared, which no later pass would rewrite — the model can see the
         * link already and correctly declines to propose it again.
         */
        const restored = {
          at: Date.now(),
          shapes,
          value: {
            ...value,
            resources: withVerifiedParams(value.resources, connection.ops),
          },
        };
        enumerated.set(connection.id, restored);
        return restored;
      }
    }

    const shapes: Record<string, InferredShape> = {};
    const byOpShape = new Map<string, InferredShape>();

    const value = await analyseConnection(
      connection,
      sampleFor(connection, (opId, shape) => byOpShape.set(opId, shape)),
      budget,
    );

    // Re-key the shapes from op id onto resource id, which is what the
    // suggestion engine reasons in.
    for (const resource of value.resources) {
      const shape = resource.listOp ? byOpShape.get(resource.listOp) : undefined;
      if (shape) shapes[resource.id] = shape;
    }

    const entry = { at: Date.now(), value, shapes };
    enumerated.set(connection.id, entry);
    // Write it down so the next process — or the next drawer opening after a
    // restart — costs nothing.
    store.putReport(toReport(connection, value, shapes));
    return entry;
  };

  /**
   * Create a board from a title, slugified and de-duplicated.
   *
   * One implementation because there are two callers — the HTTP route and the
   * assistant's `create_dashboard` — and two id rules would eventually
   * disagree about what "Finance" is called.
   */
  const createDashboardSpec = (title: string): DashboardSpec => {
    /* The same slug rule onboarding reserves its board ids by. */
    const id = allocateDashboardId(title, new Set(store.listDashboards().map((board) => board.id)));

    const parsed = dashboardSchema.safeParse({ id, title, widgets: [] });
    if (!parsed.success) {
      throw new Error(
        `invalid dashboard: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    store.putDashboard(parsed.data);
    return parsed.data;
  };

  const ensureBoardFor = (
    connection: Pick<ConnectionSpec, "id" | "title" | "onboarding">,
    options: { evenWhenOnboarding?: boolean } = {},
  ): void => {
    /*
     * A connection going through onboarding gets exactly the boards chosen
     * there, and not an empty one beside them. Anything else — a connection
     * made by hand, over the API, or before onboarding existed — keeps the
     * empty board it always had. `evenWhenOnboarding` is setup being skipped:
     * somebody who said "not now" still needs somewhere to land.
     */
    if (connection.onboarding && !options.evenWhenOnboarding) return;
    if (store.getDashboard(connection.id)) return;
    const board = dashboardSchema.safeParse({
      id: connection.id,
      title: connection.title,
      widgets: [],
    });
    if (board.success) store.putDashboard(board.data);
  };

  const reloadConnections = (): void => {
    for (const connection of store.listConnections()) {
      registry.addConnection(connection);
      ensureBoardFor(connection);
    }
  };
  reloadConnections();

  /**
   * Several routes (validate, refresh) legitimately take no body. Fastify
   * rejects an unrecognised content type outright, so a plain `POST` with no
   * payload 415s — the same trap that bit FreeBird Studio. Accept an empty
   * body for any content type Fastify does not already handle; malformed JSON
   * still goes through the built-in parser and still fails loudly.
   */
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
    const text = String(body ?? "").trim();
    done(null, text === "" ? undefined : text);
  });

  // The built-in JSON parser also rejects an *empty* body when the client sets
  // `content-type: application/json` — which most HTTP clients do by default
  // on a POST, even with nothing to send. Tolerate empty; still reject junk.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = String(body ?? "").trim();
    if (text === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error("body is not valid JSON"), { statusCode: 400 }), undefined);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AdapterError) {
      return reply.status(error.status).send({ error: error.userMessage, detail: error.message });
    }
    if (error instanceof BlockedUrlError) {
      return reply.status(400).send({ error: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: "invalid request", detail: error.issues });
    }
    // Framework errors already carry the right status; flattening them all to
    // 500 turns "you sent the wrong content type" into "our server broke".
    const carrier = error as { statusCode?: unknown; message?: unknown };
    const status = typeof carrier.statusCode === "number" ? carrier.statusCode : 500;
    if (status >= 500) app.log.error(error);
    return reply.status(status).send({
      error:
        status >= 500
          ? "something went wrong on our side"
          : typeof carrier.message === "string"
            ? carrier.message
            : "bad request",
    });
  });

  /*
   * Health, and whether the assistant is actually available.
   *
   * `chat` is reported because the client otherwise cannot tell "still
   * connecting" from "there is no chat here". Chat storage is allowed to fail
   * on its own — a damaged embedded database must not take down dashboards —
   * but the failure was invisible to the browser, which sat on a disabled box
   * reading "Starting…" indefinitely. A boot problem the server states plainly
   * on the console deserves to be visible in the UI too.
   */
  app.get("/api/health", async () => ({ ok: true, chat: Boolean(options.chat) }));

  // ── parts ───────────────────────────────────────────────────────────────
  //
  // Registered as a plugin, which is the shape every route group is moving
  // to: a function of its dependencies rather than a closure over one big
  // builder.
  void app.register(partsRoutes(options.parts));

  /*
   * Half-finished widget setups, one per board.
   *
   * Durable when there is a chat database, because a setup half-finished when
   * the server restarts is exactly the case worth surviving — eight answers is
   * real work to lose. It lands in FreeBird's `freebird_scratch`, which is a
   * namespaced blob store that knows nothing about widgets; the scope is the
   * **board id** rather than a chat session, so a setup started from the card
   * works before the assistant has ever been opened.
   *
   * Without a chat database there is nowhere durable to put it, so it stays in
   * memory rather than inventing a second storage path — an install that opted
   * out of a database has not asked for one.
   *
   * The identity is concrete and always supplied. `freebird_scratch` folds
   * tenant and user into its primary key so a blank one cannot read another's
   * rows, but a blank one would still share a partition with every other blank
   * caller, which is not a thing to leave to chance.
   */
  /*
   * Answers a person has already confirmed. Falls back to an in-memory store
   * so a host that has not configured one still gets reuse within a session.
   */
  const narrowings = options.narrowings ?? new NarrowingStore(join(tmpdir(), "dash-narrowings"));

  const drafts: DraftStore = options.chat
    ? new ScratchDraftStore(options.chat.adapter, { userId: LOCAL_USER_ID })
    : new MemoryDraftStore();

  /*
   * Every question the guided setup can ask, from disk alone.
   *
   * Rebuilt per request rather than captured once: a connection read halfway
   * through a conversation should be answerable in the next question, not
   * after a restart. Building it costs no requests — that is the whole point
   * of the capability report.
   */
  /**
   * Whether every credential a connection needs is stored.
   *
   * `authRequired` with no auth style chosen yet is not "ready" — the key
   * exists somewhere, we just have not been told where it goes.
   */
  const connectionHasKey = (connection: ConnectionSpec): boolean => {
    const refs = connectionKeyRefs(connection);
    return !connectionNeedsAuthSetup(connection) && refs.every((ref) => keys.has(ref));
  };

  /*
   * The one call in the guided flow that spends anything.
   *
   * It runs the same enumeration the wizard's Read step runs — same pacing,
   * same budget, same report on disk afterwards — so a connection read through
   * a conversation is indistinguishable from one read through the panel, and
   * neither re-spends what the other already paid for. Shared by the REST
   * wizard and the chat action so there is one implementation of "yes, read
   * it", and therefore one place the consent rule lives.
   */
  const readConnection = async (id: string): Promise<{ ok: boolean; note?: string }> => {
    const connection = store.getConnection(id);
    if (!connection) return { ok: false, note: `there is no connection called "${id}"` };
    if (!connectionHasKey(connection)) {
      // Belt and braces: the step machine already declines to offer a read
      // without a key, but this is the boundary that actually spends money.
      return { ok: false, note: "that API needs a key before it can be read" };
    }
    registry.addConnection(connection);
    try {
      const { value } = await enumerate(connection, true);
      return value.resources.length > 0
        ? { ok: true }
        : { ok: false, note: "the read completed but found nothing readable" };
    } catch (cause) {
      return { ok: false, note: cause instanceof Error ? cause.message : String(cause) };
    }
  };

  const conciergeContext = () =>
    buildConciergeContext({
      connections: store.listConnections(),
      reports: store.listReports(),
      // So a read is never offered for an API that would answer 401 to every
      // request it spent. The concierge sends the user to the key panel instead.
      hasKey: connectionHasKey,
      /*
       * The maps, which are what make "keys and go" true.
       *
       * A map is a property of the API and the same for everybody; the report
       * is a property of an account. Passing both means an endpoint stays
       * buildable whether or not this particular account has rows in it.
       */
      maps: options.catalog?.list() ?? [],
    });

  /*
   * Registered whether or not there is an AI key.
   *
   * This is the deterministic wizard: the card in the chat column drives these
   * routes directly, so guided setup works on an install with no model at all.
   * The chat actions are a second front door onto the same draft.
   */
  /**
   * What opening one record shows.
   *
   * Defined here rather than inside either caller because both confirm paths
   * need it — the card's `POST /confirm` and the chat's `confirm_setup` — and
   * for a long time only the chat had it. The result was a card that produced
   * records with no related collections while the chat produced them
   * correctly, from the same draft.
   *
   * Returns undefined when there is no AI key, which `settleDetail` reads as
   * "leave the draft alone" rather than as an error.
   */
  const planDetailFor = async (input: DetailPlanRequest): Promise<DetailSetup> => {
    const model = resolveLlm("record");
    if (!model) {
      return {
        fields: [],
        groups: [],
        sections: [],
        reason: "",
        available: { fields: [], children: [] },
        notes: [],
      };
    }
    return planDetailSetup({ llm: model, context: conciergeContext(), ...input });
  };

  /**
   * Re-read a widget's fields when an arrangement changes what it is.
   *
   * Only for the two arrangements that do: a merge and a list change what a
   * widget reads, and which field is its title is a question the records
   * answer rather than the schema. The frames — tabs, a row, a stack — never
   * reach this, so the common swap stays instant and free.
   */
  const rearrangeFor = async (input: {
    draft: ConciergeDraft;
    arrangement: Arrangement;
  }): Promise<{ draft: ConciergeDraft; notes: readonly string[]; error?: string }> => {
    const model = resolveLlm("bind");
    return rearrangeSetup({
      ...(model ? { llm: model } : {}),
      context: conciergeContext(),
      ...input,
    });
  };

  /**
   * The other reading of a request, turned back into a patch.
   *
   * Compiled here rather than at the moment the brief was written: the
   * alternative is ignored on nearly every setup, and a compile spent every
   * time to save one is the wrong way round. Nothing costs a request — the
   * record types are on disk, and this is the same `patchFromBrief` the
   * proposal ran through.
   *
   * The record type is looked up by the id the brief carries, which was
   * resolved against the roster when the brief was written. Searching every
   * described connection rather than one, because a workspace with two APIs
   * can be asked one question about either.
   */
  const compileReading = (brief: WidgetBrief): { patch: DraftPatch; error?: string } => {
    for (const entry of store.listConnections()) {
      const entities = entry.catalog ? (options.catalog?.get(entry.catalog)?.entities ?? []) : [];
      const entity = entityById(entities, brief.entity);
      const resource = entity
        ? entry.resources.find((one) => one.id === entity.resource)
        : undefined;
      if (!entity || !resource) continue;

      const mapped = patchFromBrief({
        brief,
        entity,
        resource,
        connection: entry.id,
        listPath: pathOf(entry, resource.listOp),
        related: relatedFor(entry, entities),
        id: entity.id,
      });
      /*
       * A patch with no endpoint did not compile, and the compiler's own
       * sentence beats a generic one — it is the only thing that knows which
       * of the record type's fields the reading needed and did not find.
       */
      return mapped.patch.endpoint
        ? { patch: mapped.patch }
        : {
            patch: {},
            error:
              mapped.notes[0] ??
              `That reading could not be built from what this API offers of ${entity.name.many}.`,
          };
    }
    return { patch: {}, error: "The record type that reading is about is no longer described." };
  };

  void app.register(
    conciergeRoutes({
      previews,
      drafts,
      context: conciergeContext,
      planDetail: planDetailFor,
      rearrange: rearrangeFor,
      compileReading,
      getDashboard: (id) => store.getDashboard(id),
      putDashboard: (spec) => store.putDashboard(spec),
      /*
       * The one call in the guided flow that spends anything.
       *
       * It runs the same enumeration the Read step in the wizard runs — same
       * pacing, same budget, same report on disk afterwards — so a connection
       * read through a conversation is indistinguishable from one read through
       * the panel, and neither re-spends what the other already paid for.
       */
      readConnection,
    }),
  );

  /**
   * The keeper: what keeps a board free to look at.
   *
   * Views no longer fetch, so something has to keep the answers current, and
   * it should be something nobody is waiting for. This refreshes each warm
   * target on a cadence, through the same cache and the same gate as
   * everything else, at the priority that yields to anything on screen.
   *
   * Not started in tests unless asked: a suite that builds a server should not
   * acquire a timer and a background appetite for somebody's API.
   */
  const keeper = new Keeper({
    targets: () => {
      const connections = store.listConnections();
      const entityLinks: Record<string, EntityLinkView[]> = {};
      for (const connection of connections) {
        const links = linksFor(connection);
        if (links.length > 0) entityLinks[connection.id] = [...links];
      }
      return warmTargets({
        dashboards: store.listDashboards(),
        connections,
        entityLinks,
        viewed: viewed.recent(Date.now()),
        now: () => Date.now(),
      });
    },
    refresh: async (target) => {
      const spec = store.getConnection(target.connection);
      if (!spec) return;
      const op = getOp(spec, target.op);
      if (!op) return;
      registry.addConnection(spec);
      refreshQueryIdentity(spec);

      /*
       * Exactly the request a board sends: the query string and the resolved
       * window and inputs were built by `buildQueryRequest`, or recorded from
       * `/api/query` itself, so the upstream call and the key both match.
       */
      return queries.read({
        key: target.key,
        connection: target.connection,
        /* Somebody has to ask the API something, and this is the only thing
         * that does now. Zero, because a warm copy the keeper hands back to
         * itself would leave the cache exactly as stale as it found it. */
        maxAgeMs: 0,
        mode: "refresh",
        priority: Priority.Background,
        fetcher: (validators) =>
          registry.fetch(target.connection, target.op, { ...target.overrides }, {
            params: target.resolved,
            now: Date.now(),
            resolveSecret: async (keyRef) => keys.get(keyRef),
            ...(validators ? { validators } : {}),
          }),
      });
    },
    lastReadAt: (connection) => seen.seenAt(connection),
    storedAt: (key) => queries.storedAt(key),
    coolingUntil: (connection) => queries.coolingUntil(connection),
    everyMsFor: (target) => everyMsForOp(target.connection, target.op, target.everyMs),
    now: () => Date.now(),
  });

  /*
   * A credential change invalidates the connection's data, and it is also the
   * one event that can turn a 401 or a 403 into a yes. Without this, a key
   * pasted wrong and then fixed left the keeper refusing to touch the
   * connection's endpoints until the server restarted.
   */
  queries.onInvalidate((connection) => keeper.forget(connection));

  if (options.keeper === true) keeper.start();
  app.addHook("onClose", async () => keeper.stop());

  /** What the keeper is holding, and when each part of it comes round. */
  /*
   * The warm set as it stands now — not only what the keeper has taken stock
   * of on a tick — with whether the cache already holds each one. `cached`
   * is what proves the keeper and the boards agree: a target a board has
   * read is cached under exactly the key listed here, or the two disagree.
   */
  app.get("/api/keeper", async () => {
    const known = new Map(keeper.state().map((entry) => [entry.target.key, entry]));
    return {
      running: options.keeper === true,
      targets: keeper.currentTargets().map((target) => {
        const entry = known.get(target.key);
        return {
          connection: target.connection,
          op: target.op,
          key: target.key,
          because: target.because,
          ...(target.dashboard ? { dashboard: target.dashboard } : {}),
          cached: queries.storedAt(target.key) !== null,
          everyMs: entry?.everyMs ?? everyMsForOp(target.connection, target.op, target.everyMs),
          ...(entry ? { dueAt: entry.dueAt } : {}),
          ...(entry?.denied ? { denied: entry.denied } : {}),
        };
      }),
    };
  });

  // ── connections ─────────────────────────────────────────────────────────
  //
  // A connection is public except for its key: responses report `hasKey`,
  // never the secret, so a leaked spec file or a screenshotted API response
  // is worthless.
  /**
   * The URL of one of a connection's endpoints, for the compiler's one check.
   *
   * A path still carrying a parameter needs an id a widget on a board has
   * nowhere to get, so the compiler refuses rather than emitting something
   * that cannot fetch. Read off the connection rather than the catalog: what
   * matters is the endpoint *this* connection would call.
   */
  const pathOf = (
    connection: { readonly ops: readonly { readonly id: string; readonly path: string }[] },
    op: string | undefined,
  ): string | undefined => (op ? connection.ops.find((one) => one.id === op)?.path : undefined);

  /**
   * The rest of an API, for a brief that names two record types.
   *
   * The catalog's record types with *this connection's* endpoints, which is
   * the same pairing a record page is built from and for the same reason: the
   * catalog describes the whole API, a connection may hold a subset of it, and
   * a join naming an endpoint this connection does not carry is one nothing
   * here could ever fetch.
   */
  const relatedFor = (
    connection: NonNullable<ReturnType<SpecStore["getConnection"]>>,
    entities: readonly EntitySpec[],
  ) => ({
    entities,
    resources: connection.resources,
    ops: connection.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
  });

  /**
   * Which of a connection's fields point at other records.
   *
   * Extracted because two callers need the same answer: the public connection
   * the browser reads, and the keeper deciding which reference lists are worth
   * warming. Derived on every call rather than stored — it is a property of
   * the API, read off the catalog, so re-describing one is live everywhere at
   * once.
   */
  const linksFor = (
    connection: NonNullable<ReturnType<SpecStore["getConnection"]>>,
  ): readonly EntityLinkView[] => {
    const entities = connection.catalog
      ? (options.catalog?.get(connection.catalog)?.entities ?? [])
      : [];
    if (entities.length === 0) return [];
    return entityLinkViews({
      entities,
      resources: connection.resources,
      ops: connection.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
    });
  };

  const publicConnection = (connection: ReturnType<SpecStore["getConnection"]>) => {
    if (!connection) return null;
    const refs = connectionKeyRefs(connection);
    // `authRequired` with no auth style chosen yet is not "ready" — the key
    // exists somewhere, we just have not been told where it goes.
    const hasKey = !connectionNeedsAuthSetup(connection) && refs.every((ref) => keys.has(ref));
    /*
     * What this API's fields are called, derived rather than stored.
     *
     * Read off the described record types on every request, so there is one
     * copy to correct and re-describing an API is live for every connection to
     * it at once. It used to be written by a model pass of its own, run inside
     * every mapping and costing a call per batch of field names — for a worse
     * answer than the describing pass already gives, since one map keyed by
     * bare field name has to give `Title` a single meaning for the whole API.
     *
     * This is the fallback, not the answer: a widget that knows its record
     * type gets that record type's own words (`EntityLinkView.labels`), which
     * outrank these. This serves the places holding a field name and nothing
     * else.
     *
     * Empty for a connection to an API nobody has described, which every
     * renderer already handles by falling back to the mechanical label.
     */
    const labels = connection.catalog
      ? fieldLexicon(options.catalog?.get(connection.catalog)?.entities ?? [])
      : {};
    /*
     * Which of this API's fields point at other records, resolved the same way
     * and for the same reason — a property of the API, kept once on the
     * catalog entry rather than copied onto every connection to it.
     *
     * Deliberately the *links* and not the record types. A browser needs to
     * know that a column holds a vendor's id, what a vendor is called, and
     * which endpoint returns one; it does not need the twelve hundred field
     * descriptions that make the artifact worth sharing, and on a real API
     * that difference is tens of kilobytes against well over a megabyte on a
     * payload read at every page load.
     *
     * The ops come from the *connection* rather than the catalog: a reach plan
     * that names an endpoint this connection does not carry is a link nothing
     * here could follow.
     */
    const entities = connection.catalog
      ? (options.catalog?.get(connection.catalog)?.entities ?? [])
      : [];
    const entityLinks = linksFor(connection);
    /*
     * Which of this connection's endpoints actually read the time range.
     *
     * Published rather than re-derived in the browser, because the browser and
     * this server must build the *same* cache key and `queryKey`'s own
     * docblock says what two spellings of a key cost. Cheap: it reads the op's
     * own query and the dialect, with no resolution and no parse.
     */
    const rangeOps = connection.ops
      .filter((op) => opUsesRange(connection, op))
      .map((op) => op.id);

    return { ...connection, hasKey, labels, entityLinks, rangeOps };
  };

  app.get("/api/connections", async () =>
    store.listConnections().map((connection) => publicConnection(connection)),
  );

  app.get<{ Params: { id: string } }>("/api/connections/:id", async (request, reply) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) return reply.status(404).send({ error: "no such connection" });
    return publicConnection(connection);
  });

  /**
   * The record types this connection has, for choosing between.
   *
   * A hundred plain nouns with a sentence each, which is what the manual
   * builder offers instead of two hundred endpoints titled "Retrieve all X".
   * Deliberately light: what each record type *contains* is a second request,
   * made only for the one somebody picked.
   */
  app.get<{ Params: { id: string } }>("/api/connections/:id/entities", async (request, reply) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) return reply.status(404).send({ error: "no such connection" });

    const entities = connection.catalog
      ? (options.catalog?.get(connection.catalog)?.entities ?? [])
      : [];

    /*
     * The endpoints *this connection* carries, which is not the same as the
     * ones the API has. A connection may hold a subset, and a resource keeps
     * declaring its list endpoint either way — so asking the resource alone
     * would advertise a record type nothing here could fetch.
     */
    const carried = new Set(connection.ops.map((op) => op.id));

    return entities.map((entity) => {
      const resource = connection.resources.find((one) => one.id === entity.resource);
      return {
        entity: entity.id,
        name: entity.name,
        kind: entity.kind,
        ...(entity.description ? { description: entity.description } : {}),
        /** Whether somebody would start a widget from these, or only reach them. */
        starting: recipeFor(entity.kind).starting,
        /**
         * Whether anything here lists them.
         *
         * A record type nothing lists cannot be a widget however well
         * described it is, and offering it would be offering a dead end.
         */
        listable: Boolean(resource?.listOp && carried.has(resource.listOp)),
      };
    });
  });

  /**
   * A brief somebody assembled by hand, compiled.
   *
   * The same compiler the described path uses, which is the point: a widget
   * built by picking fields and one built by describing it cannot disagree
   * about what the same request means, because there is only one thing that
   * turns a brief into a widget.
   *
   * No model and no API requests — every decision is already recorded in the
   * record type.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/connections/:id/compile",
    async (request, reply) => {
      const parsed = z
        .object({ brief: widgetBriefSchema, dashboardId: z.string().optional() })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid brief", detail: parsed.error.issues });
      }

      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const entities = connection.catalog
        ? (options.catalog?.get(connection.catalog)?.entities ?? [])
        : [];
      const entity = entityById(entities, parsed.data.brief.entity);
      const resource = entity
        ? connection.resources.find((one) => one.id === entity.resource)
        : undefined;
      if (!entity || !resource) {
        return reply
          .status(409)
          .send({ error: "That record type is not one this connection carries." });
      }
      /*
       * And the endpoint that lists them has to be one this connection holds.
       * Compiling against a resource's declaration alone would produce a widget
       * naming an endpoint nothing here can call — which fails at the first
       * fetch, long after the point anybody could understand why.
       */
      if (!resource.listOp || !connection.ops.some((op) => op.id === resource.listOp)) {
        return reply.status(409).send({
          error: `This connection does not carry the endpoint that lists ${entity.name.many.toLowerCase()}.`,
        });
      }

      const board = parsed.data.dashboardId ? store.getDashboard(parsed.data.dashboardId) : null;
      const taken = new Set((board?.widgets ?? []).map((widget) => widget.id));

      const compiled = compileBrief({
        brief: parsed.data.brief,
        entity,
        resource,
        connection: connection.id,
        listPath: pathOf(connection, resource.listOp),
        related: relatedFor(connection, entities),
        id: widgetId(parsed.data.brief.title ?? entity.name.many, taken),
      });

      return { widget: compiled.widget, notes: compiled.notes, errors: compiled.errors };
    },
  );

  /**
   * One record type, with everything its page needs.
   *
   * Separate from the connection payload, and that is a measurement rather
   * than a preference: everything pages need for a real API's 108 record types
   * is about 132 KB, against 8.3 KB for the largest single record type on its
   * own. The first would be paid on every page load by everybody; this is paid
   * once by whoever opens a page.
   *
   * The ops come from the *connection* rather than the catalog, for the same
   * reason the links do: a reach plan naming an endpoint this connection does
   * not carry is a section nothing here could fetch.
   */
  app.get<{ Params: { id: string; entity: string } }>(
    "/api/connections/:id/entities/:entity",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const entities = connection.catalog
        ? (options.catalog?.get(connection.catalog)?.entities ?? [])
        : [];
      const page = entityPageView(
        {
          entities,
          resources: connection.resources,
          ops: connection.ops.map((op) => ({ id: op.id, path: op.path, params: op.params })),
        },
        request.params.entity,
      );
      /*
       * A record type nobody has described is a 404 rather than an empty page:
       * the difference between "this API has no such thing" and "this thing
       * has nothing on it" is the whole question the reader is asking.
       */
      if (!page) return reply.status(404).send({ error: "no such record type" });
      return page;
    },
  );

  /**
   * How a record type's page is laid out, changed for everybody.
   *
   * The layer between the code's own guess and one widget's private change:
   * the record type's own answer, so every route into a record — a link from
   * another record's column, a shared URL, any widget's row — arrives at the
   * same page, and improving it improves all of them at once. A widget that
   * wants something different stores only that difference against itself and
   * inherits the rest.
   *
   * Written to the catalog's local tier, which is what makes this an override
   * rather than an edit to what shipped: abandoning it is a delete, not an
   * unwinding.
   */
  app.put<{ Params: { id: string; entity: string }; Body: unknown }>(
    "/api/connections/:id/entities/:entity/layout",
    async (request, reply) => {
      const parsed = z
        .object({
          facts: z.array(fieldPathSchema).max(4).default([]),
          groups: z.array(fieldGroupSchema).max(8).default([]),
        })
        .safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid layout", detail: parsed.error.issues });
      }

      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      const entry = connection.catalog ? options.catalog?.get(connection.catalog) : undefined;
      const entity = entry?.entities?.find((one) => one.id === request.params.entity);
      if (!entry || !entity) return reply.status(404).send({ error: "no such record type" });

      /*
       * Checked against the record type's own fields rather than trusted.
       * A layout naming a field that does not exist produces a pane that
       * cannot bind, and that renders as "this view no longer matches its
       * data" — which blames the reader's data for a bad write here.
       */
      const shown = new Set(
        entity.fields.filter((f) => f.visibility !== "hidden").map((f) => f.path),
      );
      const unknown = [
        ...parsed.data.facts,
        ...parsed.data.groups.flatMap((group) => group.fields),
      ].filter((path) => !shown.has(path));
      if (unknown.length > 0) {
        return reply.status(400).send({
          error: `${entity.name.many} do not show ${unknown.join(", ")}.`,
        });
      }

      const saved = options.catalog!.put({
        ...entry,
        entities: (entry.entities ?? []).map((one) =>
          one.id === entity.id
            ? {
                ...one,
                views: {
                  ...one.views,
                  // Only the page's half. Columns, sort, strips and stats are
                  // a different screen's business and must not be cleared by
                  // a write about the layout of a record.
                  record: { facts: parsed.data.facts, groups: parsed.data.groups },
                },
              }
            : one,
        ),
      });

      return saved.entities?.find((one) => one.id === entity.id)?.views.record ?? { facts: [], groups: [] };
    },
  );

  /**
   * A field name that reads as somebody else's identity.
   *
   * `userId`, `album_id`, `postIds`, `id` — and deliberately not `valid` or
   * `hybrid`, which is the whole reason this is not `/id$/i`. Two spellings
   * rather than one clever pattern, because the two are genuinely different
   * conventions and a reader should be able to see which one matched.
   */
  const looksLikeAnId = (path: string): boolean => {
    const last = path.split(".").pop() ?? "";
    return /[a-z0-9]Ids?$/.test(last) || /(?:^|_)ids?$/i.test(last);
  };

  /**
   * Every link between this API's record types, and what it would take to
   * correct one.
   *
   * Read from the record types themselves rather than from the endpoint-level
   * relations: those are two different models, and this is the one that
   * decides what a widget is built from. The reach travels with each link
   * because "points at Users" and "points at Users and can be opened" are
   * different facts, and only the second makes a name appear in a cell.
   */
  app.get<{ Params: { id: string } }>(
    "/api/connections/:id/references",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      const entities = connection.catalog
        ? (options.catalog?.get(connection.catalog)?.entities ?? [])
        : [];
      if (entities.length === 0) return { described: false, entities: [], links: [] };

      const graph = entityGraph(relatedFor(connection, entities));
      const nameOf = (id: string): string =>
        entityById(entities, id)?.name.many ?? id;

      return {
        described: true,
        /** Every record type, so a correction can name a different one. */
        entities: entities.map((entity) => ({ id: entity.id, title: entity.name.many })),
        links: entities.flatMap((entity) =>
          graph.referencesOf(entity.id).map((reference) => ({
            entity: entity.id,
            from: entity.name.many,
            field: reference.field,
            label: reference.label ?? reference.field,
            target: reference.target,
            to: nameOf(reference.target),
            /*
             * `free` means the row already carries the name, so nothing is
             * fetched. A null reach is a link nothing can open — worth saying,
             * because it looks identical in a widget until it is clicked.
             */
            cost: reference.cost,
            openable: reference.reach !== null,
            verified: reference.verified,
          })),
        ),
        /**
         * Fields that look like a link and are not recorded as one.
         *
         * Listed for two reasons, and the second is the one that forced it:
         * the describe pass misses links, and — since saying "not a link" is
         * an answer here — a field corrected that way would otherwise vanish
         * from the only screen that could put it back. A name ending in `Id`
         * is the whole test, which is deliberately weak: this is a list of
         * things to look at, not a claim that any of them point anywhere.
         */
        candidates: entities.flatMap((entity) =>
          entity.fields
            .filter(
              (field) =>
                !field.reference &&
                field.path !== entity.identity?.field &&
                looksLikeAnId(field.path),
            )
            .slice(0, 12)
            .map((field) => ({
              entity: entity.id,
              from: entity.name.many,
              field: field.path,
              label: field.label ?? field.path,
            })),
        ),
        /** Links the record types record and nothing here could execute. */
        unreachable: graph.unreachable,
      };
    },
  );

  /**
   * Correct where one of a record's fields points.
   *
   * The links that decide widgets are the ones on the record types, and until
   * now they were the only ones nobody could correct: the editor in
   * Connections → Manage edits `resource.relations`, an endpoint-level model
   * that a described API no longer consults. A link you can see being wrong
   * and cannot fix is worse than one that is merely missing.
   *
   * One field at a time, `PUT` because the reference is replaced whole, and
   * `null` removes it — which is the honest answer for a field that resembles
   * a link and is not one. What is written here is what the describing pass
   * wrote, in the same place, so everything downstream — the brief compiler,
   * record pages, the reference cells — reads the correction with no second
   * path to keep in step.
   */
  app.put<{ Params: { id: string; entity: string }; Body: unknown }>(
    "/api/connections/:id/entities/:entity/reference",
    async (request, reply) => {
      const parsed = z
        .object({
          field: fieldPathSchema,
          /** The record type it points at, or null to say it points at none. */
          target: z.string().min(1).max(64).nullable(),
        })
        .safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid reference", detail: parsed.error.issues });
      }

      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      const entry = connection.catalog ? options.catalog?.get(connection.catalog) : undefined;
      const entity = entry?.entities?.find((one) => one.id === request.params.entity);
      if (!entry || !entity) return reply.status(404).send({ error: "no such record type" });

      const field = entity.fields.find((one) => one.path === parsed.data.field);
      if (!field) {
        return reply.status(400).send({
          error: `${entity.name.many} have no field called ${parsed.data.field}.`,
        });
      }
      /*
       * A target off the roster is refused rather than stored. A reference
       * naming a record type nothing describes resolves to nothing, and every
       * reader of it would report a link that simply never opens.
       */
      const target = parsed.data.target
        ? entityById(entry.entities ?? [], parsed.data.target)
        : null;
      if (parsed.data.target && !target) {
        return reply.status(400).send({
          error: `There is no record type here called "${parsed.data.target}".`,
        });
      }

      const saved = options.catalog!.put({
        ...entry,
        entities: (entry.entities ?? []).map((one) =>
          one.id === entity.id
            ? {
                ...one,
                fields: one.fields.map((each) =>
                  each.path !== field.path
                    ? each
                    : target
                      ? {
                          ...each,
                          reference: {
                            ...(each.reference ?? { holds: "scalar" as const, embedded: [] }),
                            entity: target.id,
                            /*
                             * A correction is somebody saying so, which is not
                             * the same as a request having resolved there.
                             * Clearing this puts the link back in the queue the
                             * check pass works through, rather than letting a
                             * new target inherit the old one's proof.
                             */
                            verified: false,
                          },
                        }
                      : { ...each, reference: undefined },
                ),
              }
            : one,
        ),
      });

      const after = saved.entities?.find((one) => one.id === entity.id);
      return {
        field: field.path,
        reference: after?.fields.find((one) => one.path === field.path)?.reference ?? null,
      };
    },
  );

  /**
   * Check what has been described against the real account.
   *
   * The one thing in this whole layer that spends somebody's API quota, which
   * is why it is a request somebody makes rather than something that happens
   * on its own. Two claims cannot be settled by re-reading a specification:
   * that a field identifies a record, and that a field pointing at another
   * record type really resolves there. Both are settled by asking.
   *
   * Budgeted, and the budget is the point: a real API has a hundred record
   * types and as many links again, so an unbounded check is hundreds of
   * requests against an account that rate-limits.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/connections/:id/verify",
    async (request, reply) => {
      const parsed = z
        .object({ budget: z.number().int().min(1).max(VERIFY_BUDGET_MAX).optional() })
        .safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid budget", detail: parsed.error.issues });
      }

      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const entry = connection.catalog ? options.catalog?.get(connection.catalog) : undefined;
      const entities = entry?.entities ?? [];
      if (entities.length === 0) {
        return reply.status(409).send({
          error: "This API's records have not been described yet, so there is nothing to check.",
        });
      }
      registry.addConnection(connection);

      const carried = new Set(connection.ops.map((op) => op.id));
      const result = await verifyRecords({
        entities,
        resources: connection.resources,
        carried,
        rowsPathOf: (op) => getOp(connection, op)?.rowsPath,
        budget: parsed.data.budget ?? VERIFY_BUDGET_DEFAULT,
        read: async (op, params) => {
          try {
            /*
             * The id goes in as a filter rather than as an override: a by-id
             * endpoint carries it in its *path*, and a path token reads the
             * filters, while an override would only ever become a query
             * parameter the endpoint never asked for.
             */
            const fetched = await upstream(connection.id, () =>
              registry.fetch(connection.id, op, {}, {
                params: {
                  range: resolveRange({ preset: "30d", now: Date.now() }),
                  filters: params,
                },
                now: Date.now(),
                resolveSecret: async (keyRef) => keys.get(keyRef),
              }),
            );
            return { ok: true, body: fetched.body };
          } catch (error) {
            /*
             * A refusal is an outcome here, not a failure: the run records how
             * far it got and stops. Only the status matters — what is being
             * decided is whether to keep asking.
             */
            return {
              ok: false,
              body: null,
              ...(error instanceof AdapterError ? { status: error.status } : {}),
            };
          }
        },
      });

      /*
       * Merged rather than written over, and through the same rule a
       * re-description uses: evidence gathered here is carried onto whatever
       * the catalog holds *now*, so a describe run that finished while this
       * was in flight keeps its newer prose, and evidence about a claim that
       * has since changed lapses instead of vouching for something else.
       */
      if (entry && options.catalog) {
        const current = options.catalog.get(entry.id) ?? entry;
        options.catalog.put({
          ...current,
          entities: mergeDescribedEntities(result.entities, current.entities ?? []),
          entitiesVerifiedAt: new Date().toISOString(),
        });
      }

      return {
        checked: result.checked,
        identitiesConfirmed: result.identitiesConfirmed,
        referencesResolved: result.referencesResolved,
        requests: result.spent,
        stopped: result.stopped,
        notes: result.notes,
      };
    },
  );

  /**
   * A request for a widget, answered from the record types.
   *
   * The entity-first path: one model call names the records and says what the
   * widget is *for*, and everything else — the endpoint, the columns, the
   * sort, the filter strips, the pipeline — is worked out deterministically
   * from the record type and its kind. The model never writes a pipeline it
   * could get subtly wrong; it writes a handful of names that are checked
   * against the real thing.
   *
   * Returns a widget rather than storing one. Adding it to a board is the
   * caller's own act, through the path that already does that — so a proposal
   * nobody accepted changes nothing.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/connections/:id/brief",
    async (request, reply) => {
      const parsed = z
        .object({
          intent: z.string().min(1).max(500),
          /** The board it will land on, so its id cannot collide there. */
          dashboardId: z.string().optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "a request in the user's own words is needed" });
      }

      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const entities = connection.catalog
        ? (options.catalog?.get(connection.catalog)?.entities ?? [])
        : [];
      if (entities.length === 0) {
        return reply.status(409).send({
          error:
            "This API's records have not been described yet, so there is nothing to build from.",
        });
      }

      const llm = resolveLlm("widget");
      if (!llm) {
        return reply.status(400).send({
          error:
            "Building a widget needs an AI key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY on the server.",
        });
      }

      const written = await writeBrief(llm, {
        intent: parsed.data.intent,
        // One source by construction: this route is addressed to one
        // connection, so there is nothing to choose between.
        candidates: briefCandidates([
          { connection: connection.id, title: connection.title, entities },
        ]),
      });
      if (!written.brief) {
        return reply.status(502).send({ error: written.error ?? "no brief was written" });
      }

      /*
       * The record type has to be one *this connection* carries. The catalog
       * describes the whole API; a connection may hold a subset of it, and a
       * widget over an endpoint this connection does not have is one nothing
       * could ever fetch.
       */
      const entity = entityById(entities, written.brief.entity);
      const resource = entity
        ? connection.resources.find((one) => one.id === entity.resource)
        : undefined;
      if (!entity || !resource) {
        return reply
          .status(409)
          .send({ error: "That record type is not one this connection carries." });
      }

      const board = parsed.data.dashboardId ? store.getDashboard(parsed.data.dashboardId) : null;
      const taken = new Set((board?.widgets ?? []).map((widget) => widget.id));

      const compiled = compileBrief({
        brief: written.brief,
        entity,
        resource,
        connection: connection.id,
        listPath: pathOf(connection, resource.listOp),
        related: relatedFor(connection, entities),
        id: widgetId(written.brief.title ?? entity.name.many, taken),
      });

      /*
       * The other reading, compiled in the same breath as the first.
       *
       * Offered rather than asked about: blocking on "did you mean the records
       * or a count of them?" makes every request an interrogation, and the
       * answer is usually plain. Compiling both here means switching costs no
       * second model call and no second wait — which is what lets the question
       * go unasked without the other reading becoming unreachable.
       */
      const other = written.alternative;
      const otherEntity = other ? entityById(entities, other.brief.entity) : undefined;
      const otherResource = otherEntity
        ? connection.resources.find((one) => one.id === otherEntity.resource)
        : undefined;
      const otherCompiled =
        other && otherEntity && otherResource
          ? compileBrief({
              brief: other.brief,
              entity: otherEntity,
              resource: otherResource,
              connection: connection.id,
              listPath: pathOf(connection, otherResource.listOp),
              related: relatedFor(connection, entities),
              id: widgetId(
                otherEntity.name.many,
                new Set([...taken, ...(compiled.widget ? [compiled.widget.id] : [])]),
              ),
            })
          : null;

      return {
        widget: compiled.widget,
        brief: written.brief,
        /** The model's own sentence about what it built, for the reader. */
        reason: written.reason,
        /** Where the answer differs from what was asked, in a reader's words. */
        notes: compiled.notes,
        errors: compiled.errors,
        /** A different reading, ready to swap to. Absent on almost every request. */
        ...(other && otherCompiled?.widget
          ? {
              alternative: {
                label: other.label,
                widget: otherCompiled.widget,
                notes: otherCompiled.notes,
              },
            }
          : {}),
      };
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/connections/:id",
    async (request, reply) => {
      /*
       * Setup progress is the server's to keep. A client saving a connection
       * from its own form does not send it, and must not wipe it by omission.
       */
      const existing = store.getConnection(request.params.id);
      const body = request.body as Record<string, unknown>;
      const parsed = connectionSchema.safeParse({
        ...(existing?.onboarding && !("onboarding" in body)
          ? { onboarding: existing.onboarding }
          : {}),
        ...body,
        id: request.params.id,
      });
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid connection", detail: parsed.error.issues });
      }
      store.putConnection(parsed.data);
      queries.invalidate(parsed.data.id);
      ensureBoardFor(parsed.data);
      registry.addConnection(parsed.data);
      return publicConnection(parsed.data);
    },
  );

  app.put<{ Params: { id: string }; Body: { key?: string; keys?: Record<string, unknown> } }>(
    "/api/connections/:id/key",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      if (connectionKeyRefs(connection).length === 0) {
        return reply.status(400).send({ error: "this connection does not use a key" });
      }
      const refs = connectionKeyRefs(connection);

      // Multi-part auth sends { keys: { <keyRef>: value } }; the single-secret
      // styles keep the original { key } shape so nothing existing breaks.
      const supplied: Record<string, string> = {};
      if (request.body?.keys && typeof request.body.keys === "object") {
        for (const [ref, value] of Object.entries(request.body.keys)) {
          if (typeof value === "string" && value.trim()) supplied[ref] = value.trim();
        }
      } else if (typeof request.body?.key === "string" && request.body.key.trim()) {
        // Only unambiguous when there is exactly one secret to set.
        if (refs.length > 1) {
          return reply.status(400).send({
            error: `${connection.title} needs ${refs.length} separate values — send { keys: { … } }, not a single key.`,
          });
        }
        supplied[refs[0]!] = request.body.key.trim();
      }

      const missing = refs.filter((ref) => !supplied[ref] && !keys.has(ref));
      if (Object.keys(supplied).length === 0 || missing.length > 0) {
        return reply.status(400).send({
          error:
            missing.length > 0
              ? `still missing a value for: ${missing.join(", ")}`
              : "a key is required",
        });
      }

      for (const [ref, value] of Object.entries(supplied)) {
        if (refs.includes(ref)) keys.set(ref, value);
      }
      store.putConnection({
        ...connection,
        credentialsRevision: (connection.credentialsRevision ?? 0) + 1,
      });
      queries.invalidate(connection.id);
      // Echo only the fact that it worked. Never the key, not even truncated.
      return { ok: true, hasKey: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/connections/:id/key", async (request, reply) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) return reply.status(404).send({ error: "no such connection" });
    for (const ref of connectionKeyRefs(connection)) keys.delete(ref);
    store.putConnection({
      ...connection,
      credentialsRevision: (connection.credentialsRevision ?? 0) + 1,
    });
    queries.invalidate(connection.id);
    return { ok: true, hasKey: false };
  });

  /**
   * Fire the connection's declared validation op and report pass/fail fast.
   *
   * A non-technical user cannot tell "wrong key" from "wrong scope" from
   * "their service is down" without this, and a vague failure at this step is
   * where onboarding dies.
   */
  app.post<{ Params: { id: string } }>("/api/connections/:id/validate", async (request, reply) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) return reply.status(404).send({ error: "no such connection" });
    // Pick up connections written straight to disk, not just ones PUT through
    // the API — otherwise the very first thing a self-hoster does (drop a JSON
    // file in connections/, then validate it) fails until the server restarts.
    registry.addConnection(connection);

    const candidates = validationCandidates(connection);
    if (candidates.length === 0) {
      return reply.status(400).send({ error: "this connection has no operations to test" });
    }

    const params: ResolvedParams = {
      range: resolveRange({ preset: "24h", now: Date.now() }),
      filters: {},
    };

    /*
     * Try candidates until one answers, rather than concluding on the first
     * refusal.
     *
     * A 403 still means the key works — that reading has not changed — but it
     * says nothing about `rowsPath`, `pagination` or `timeFilter`, and those
     * are what `verified` claims. Stopping there left an entry whose importer
     * happened to pick an unlicensed module permanently unprovable. So a
     * refusal moves to the next endpoint and only the last one gets to decide.
     */
    const forbidden: string[] = [];
    /** Endpoint-specific failures that were not refusals. */
    const refused: string[] = [];
    let lastError: AdapterError | null = null;

    for (const opId of candidates) {
      try {
        const result = await upstream(connection.id, () =>
          registry.fetch(
            connection.id,
            opId,
            {},
            {
              params,
              now: Date.now(),
              resolveSecret: async (keyRef) => keys.get(keyRef),
            },
          ),
        );

        const summary = Array.isArray(result.body)
          ? `${result.body.length} item(s)`
          : typeof result.body === "object" && result.body !== null
            ? `${Object.keys(result.body).length} field(s)`
            : "a value";

        /*
         * This, and only this, is what verifies a catalog entry: a live
         * response with rows where the dialect said they would be.
         */
        let verified = false;
        if (catalog && connection.catalog) {
          const entryId = catalogEntryToVerify({
            connection,
            op: getOp(connection, opId),
            body: result.body,
            entry: catalog.get(connection.catalog),
          });
          if (entryId) {
            const entry = catalog.get(entryId);
            if (entry) catalog.put({ ...entry, verified: true });
            verified = true;
          }
        }

        /*
         * Adopt the endpoint that actually worked.
         *
         * Without this the connection keeps the choice that just failed, and
         * every future validate pays the same refusals again before arriving
         * back here. Recorded rather than silent — the response names it.
         */
        const adopted = verified && connection.validateOpId !== opId;
        if (adopted) store.putConnection({ ...connection, validateOpId: opId });

        return {
          ok: true,
          message: `${connection.title} responded with ${summary}.`,
          pages: result.meta.pages,
          truncated: result.meta.truncated,
          verified,
          validatedOpId: opId,
          ...(forbidden.length > 0 ? { forbidden } : {}),
          // Endpoints that broke on the way here are worth surfacing even on
          // success: nothing else in the product will mention them.
          ...(refused.length > 0 ? { failed: refused } : {}),
          ...(adopted ? { adoptedValidateOpId: opId } : {}),
        };
      } catch (error) {
        const adapterError = error instanceof AdapterError ? error : null;
        /*
         * A 401 is the only failure that is about the *connection* rather than
         * the endpoint: the credential is wrong, so every candidate would fail
         * identically and trying them proves nothing.
         *
         * Everything else — 403, 404, 422, even a 500 — is this endpoint's
         * problem. Buildium demonstrated why that distinction matters: three
         * refusals and a 422 stood between the importer's choice and the
         * endpoint that actually works, and stopping at any of them left the
         * dialect unprovable. The candidate cap is what keeps trying safe.
         */
        if (adapterError?.status === 401) {
          lastError = adapterError;
          break;
        }
        if (adapterError?.status === 403) forbidden.push(opId);
        else refused.push(opId);
        lastError = adapterError;
        continue;
      }
    }

    /*
     * Nothing answered with data. When every failure was a refusal the key is
     * still proven, so this stays a pass — the same reading as before, now
     * reached only after the alternatives are exhausted.
     */
    if (lastError?.status === 401) {
      /*
       * The adapter's own wording, not a phrase invented here: a missing key
       * and a rejected key are different diagnoses, and only the layer that
       * tried to build the request knows which one happened.
       */
      return reply.status(401).send({
        ok: false,
        error:
          lastError.userMessage ??
          `${connection.title} rejected the key. It may be wrong, expired, or revoked.`,
      });
    }
    return reply.status(lastError?.status ?? 502).send({
      ok: false,
      ...(forbidden.length > 0 ? { forbidden } : {}),
      ...(refused.length > 0 ? { failed: refused } : {}),
      tried: candidates.length,
      error: lastError?.userMessage ?? "That connection could not be reached.",
    });
  });

  // ── query ───────────────────────────────────────────────────────────────
  app.post<{ Body: unknown }>("/api/query", async (request, reply) => {
    const parsed = querySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query", detail: parsed.error.issues });
    }
    const { connection, op, params, range, filters, mode } = parsed.data;
    /* Somebody is there. Recorded before anything can fail, because a refused
     * read is still evidence that a board is open. */
    seen.touch(connection, Date.now());

    const spec = store.getConnection(connection);
    if (!spec) return reply.status(404).send({ error: `no connection "${connection}"` });
    const resolvedOp = getOp(spec, op);
    if (!resolvedOp) return reply.status(404).send({ error: `no operation "${op}"` });
    registry.addConnection(spec);

    /*
     * One spelling of the request, shared with the chat harness, the keeper
     * and onboarding's checks — every one of them has to land on the key this
     * writes. See `buildQueryRequest`.
     */
    refreshQueryIdentity(spec);
    const { key, overrides, resolved } = buildQueryRequest({
      connection,
      op: resolvedOp,
      params,
      resolved: { range: resolveRequestedRange(range, Date.now()), filters },
    });
    /* What was asked, so the keeper refreshes exactly this and not a guess. */
    viewed.record(
      { key, connection, op, overrides, resolved, shape: paramShape(params) },
      Date.now(),
    );

    try {
      const outcome = await queries.read({
        key,
        connection,
        mode,
        maxAgeMs: clampMaxAge(parsed.data.maxAgeMs),
        /*
         * Old is measured against how often this endpoint is refreshed, not
         * only against what the widget asked for. A daily endpoint read at
         * noon is not stale; labelling it so on every tile would teach people
         * to ignore the label. Only a label — a view serves what it holds
         * either way — and only while the keeper is running, since without
         * it nothing refreshes on that cadence.
         */
        ...(options.keeper === true
          ? { freshForMs: Math.round(1.5 * everyMsForOp(connection, op)) }
          : {}),
        fetcher: (validators) =>
          registry.fetch(connection, op, overrides, {
            params: resolved,
            now: Date.now(),
            resolveSecret: async (keyRef) => keys.get(keyRef),
            ...(validators ? { validators } : {}),
          }),
      });

      return {
        body: outcome.body,
        meta: {
          ...outcome.meta,
          receipt: previews.record(key, spec, op, resolved, overrides),
          cache: outcome.outcome,
          ageMs: Number.isFinite(outcome.ageMs) ? outcome.ageMs : 0,
          ...(outcome.staleReason ? { staleReason: outcome.staleReason } : {}),
        },
      };
    } catch (error) {
      // The cache re-throws the adapter's own error, which is already phrased
      // for a person; the generic handler below would flatten it to a 500.
      if (error instanceof AdapterError) {
        /*
         * `retryAfter` both ways: as the standard header, and in the body
         * because the browser reads this through `fetch` and the tile needs
         * the number to count down with. Sending only the header would leave
         * the retry button enabled during a wait it cannot win.
         */
        if (error.retryAfter) reply.header("retry-after", error.retryAfter);
        return reply.status(error.status === 429 ? 429 : 502).send({
          error: error.message,
          userMessage: error.userMessage,
          /*
           * The upstream's status, separately from ours.
           *
           * The HTTP status above is about *this* request: everything but a
           * rate limit becomes 502, because a 401 from the browser to its own
           * origin would mean something else entirely. But that flattening
           * also lost the distinction the tile needs — a 401, a 403 and a
           * generic failure are three different sentences and only one of them
           * is worth a Retry button. `describeFailure` has always had that copy
           * and could never reach it, so a permission error offered a retry
           * that could not possibly succeed.
           */
          status: error.status,
          ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        });
      }
      throw error;
    }
  });

  // ── endpoints on an existing connection ─────────────────────────────────
  //
  // Connecting an API once and then wanting a second endpoint from it is the
  // normal case, not an edge case — without these a user is back to editing
  // JSON the moment the wizard finishes.
  const withKeyFlag = (connection: ReturnType<SpecStore["getConnection"]>) => {
    if (!connection) return null;
    const refs = connectionKeyRefs(connection);
    // `authRequired` with no auth style chosen yet is not "ready" — the key
    // exists somewhere, we just have not been told where it goes.
    const hasKey = !connectionNeedsAuthSetup(connection) && refs.every((ref) => keys.has(ref));
    return { ...connection, hasKey };
  };

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/connections/:id/ops",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const parsed = opDefSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid endpoint",
          detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
      }

      // Upsert, so the same route both adds a new endpoint and edits one.
      const ops = connection.ops.filter((op) => op.id !== parsed.data.id);
      const next = connectionSchema.parse({
        ...connection,
        ops: [...ops, parsed.data],
        validateOpId: connection.validateOpId ?? parsed.data.id,
      });
      store.putConnection(next);
      queries.invalidate(next.id);
      ensureBoardFor(next);
      registry.addConnection(next);
      return withKeyFlag(next);
    },
  );

  app.delete<{ Params: { id: string; opId: string } }>(
    "/api/connections/:id/ops/:opId",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const ops = connection.ops.filter((op) => op.id !== request.params.opId);
      if (ops.length === connection.ops.length) {
        return reply.status(404).send({ error: "no such endpoint" });
      }
      const next = connectionSchema.parse({
        ...connection,
        ops,
        validateOpId: ops.some((op) => op.id === connection.validateOpId)
          ? connection.validateOpId
          : ops[0]?.id,
      });
      store.putConnection(next);
      queries.invalidate(next.id);
      ensureBoardFor(next);
      registry.addConnection(next);
      return withKeyFlag(next);
    },
  );

  /** Endpoints this connection's catalog entry offers that it isn't using. */
  app.get<{ Params: { id: string } }>(
    "/api/connections/:id/available-ops",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      if (!connection.catalog || !options.catalog) return [];

      const entry = options.catalog.get(connection.catalog);
      if (!entry) return [];
      const taken = new Set(connection.ops.map((op) => op.id));
      return entry.ops.filter((op) => !taken.has(op.id));
    },
  );

  app.delete<{ Params: { id: string } }>("/api/connections/:id", async (request) => {
    const connection = store.getConnection(request.params.id);
    // Take the secret with it — an orphaned credential in the vault is a
    // liability nobody remembers is there.
    if (connection) for (const ref of connectionKeyRefs(connection)) keys.delete(ref);
    store.deleteConnection(request.params.id);
    // The report describes an API this instance can no longer reach, and
    // leaving it behind would let a same-named connection inherit a stale one.
    store.deleteReport(request.params.id);
    enumerated.delete(request.params.id);

    /*
     * Take the board `ensureBoardFor` made, but only if it is still empty.
     *
     * Removing a connection otherwise leaves a tab that can never load
     * anything — and because the next import of the same API gets a `-2`
     * suffix, the litter is what the nav opens on. An empty auto-created board
     * is safe to drop; one with widgets on it is the user's work and stays,
     * even though those widgets will not resolve.
     */
    const board = store.getDashboard(request.params.id);
    if (board && board.widgets.length === 0) store.deleteDashboard(request.params.id);
    return { ok: true };
  });

  /**
   * Fetch one endpoint and describe what came back.
   *
   * This is what makes onboarding trustworthy: before anything is saved the
   * user sees real rows from their own account, not a green tick.
   */
  /*
   * What this connection can do, worked out from its own endpoints.
   *
   * Proposes and persists nothing: the report is offered, and a separate call
   * accepts it. Everything derivable is derived — the only thing a person is
   * ever asked for is a credential, because that is the one thing inspection
   * cannot produce.
   *
   * A POST because it samples: enumerating a connection makes real requests
   * against the upstream API, which a GET should not do.
   */
  /**
   * What reading this connection will cost, before a single request is made.
   *
   * A GET because it makes none: everything here is read off the endpoints. It
   * exists so the question "may we do this?" can be asked with a real number
   * attached rather than as a vague warning.
   */
  app.get<{ Params: { id: string }; Querystring: { deep?: string } }>(
    "/api/connections/:id/enumeration-plan",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const deep = request.query?.deep === "true";
      const budget: AnalyseOptions = deep ? { maxSamples: 60, maxChildSamples: 40 } : {};
      const stored = store.getReport(connection.id);

      return {
        ...estimateEnumeration(connection, budget),
        /** A matching report means this costs nothing at all right now. */
        alreadyRead: stored !== null && !isStale(stored, connection),
        stale: stored !== null && isStale(stored, connection),
        lastRead: stored?.generatedAt ?? null,
        previousOutcome: stored?.outcome ?? null,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { refresh?: boolean; deep?: boolean } }>(
    "/api/connections/:id/capabilities",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      registry.addConnection(connection);

      const budget: AnalyseOptions = request.body?.deep
        ? { maxSamples: 60, maxChildSamples: 40 }
        : {};
      const { value } = await enumerate(connection, request.body?.refresh === true, budget);
      return value;
    },
  );

  /**
   * What this connection believes about how its records relate — for free.
   *
   * Deliberately a GET that never enumerates: this is the screen someone opens
   * to check or correct a link, and opening it must not spend requests on
   * their API. It reads the stored report when there is a current one and
   * falls back to what the endpoints alone declare, so it is useful before
   * anything has been read as well as after.
   *
   * The whole resource array comes back, not just the relations, because
   * editing writes through `PUT /resources` which takes the graph entire.
   */
  app.get<{ Params: { id: string } }>("/api/connections/:id/relations", async (request, reply) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) return reply.status(404).send({ error: "no such connection" });

    const report = store.getReport(connection.id);
    const current = report !== null && !isStale(report, connection);
    const resources = current
      ? withVerifiedParams(fromReport(report).value.resources, connection.ops)
      : analyseStructure(connection).resources;

    return {
      connection: connection.id,
      resources,
      /** Column names per resource, so a link field is picked rather than typed. */
      fieldsByResource: Object.fromEntries(
        Object.entries(report?.shapes ?? {}).map(([id, shape]) => [
          id,
          shape.fields.map((field) => field.name),
        ]),
      ),
      source: current ? "report" : report ? "stale" : "endpoints",
      lastRead: report?.generatedAt ?? null,
    };
  });

  /** Accept a capabilities proposal. This is the approval step. */
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/connections/:id/resources",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const parsed = z
        .object({ resources: z.array(resourceSchema).max(200) })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid resources", detail: parsed.error.issues });
      }

      const next = { ...connection, resources: parsed.data.resources };
      store.putConnection(next);
      queries.invalidate(next.id);
      ensureBoardFor(next);
      registry.addConnection(next);
      return publicConnection(next);
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/connections/:id/sample",
    async (request, reply) => {
      const parsed = z.object({ op: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "an op is required" });

      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      const op = getOp(connection, parsed.data.op);
      if (!op) return reply.status(404).send({ error: "no such operation" });
      registry.addConnection(connection);

      const result = await upstream(connection.id, () =>
        registry.fetch(
          connection.id,
          op.id,
          {},
          {
            params: { range: resolveRange({ preset: "30d", now: Date.now() }), filters: {} },
            now: Date.now(),
            resolveSecret: async (keyRef) => keys.get(keyRef),
          },
        ),
      );

      const shape = inferShape(result.body, op.rowsPath ? { rowsPath: op.rowsPath } : {});
      const rows = Array.isArray(result.body)
        ? result.body
        : shape.rowsPath === "$"
          ? [result.body]
          : [];

      return {
        rowsPath: shape.rowsPath,
        rowCount: shape.rowCount,
        schemaHash: shape.schemaHash,
        fields: shape.fields.map((field) => ({
          name: field.name,
          kinds: field.kinds,
          format: field.format ?? null,
          nullable: field.nullable,
          samples: field.samples,
        })),
        meta: result.meta,
        sample: rows.slice(0, 3),
      };
    },
  );

  // ── model selection ─────────────────────────────────────────────────────
  //
  // One model per action, because the actions are not alike: picking endpoints
  // and binding fields is judgement, and answering a question about a board is
  // reading. Measured rather than assumed — see `TASKS` in models.ts for what
  // was tried and which way each one went.
  //
  // The single global choice this used to be survives as an override, for
  // anyone who would rather not think about it.
  const currentSettings = (): ModelChoices =>
    options.settings?.read() ?? { provider: null, model: null, models: {} };

  /** What runs a task, where the answer came from, and whether it can run. */
  const taskState = (task: LlmTask, settings: ModelChoices) => {
    const chosen = settings.models[task] ?? null;
    const effective = modelForTask(task, settings);
    const provider = effective ? providerFor(effective) : null;
    return {
      ...(findTask(task) as TaskInfo),
      selected: chosen,
      effective,
      source: sourceForTask(task, settings),
      // Choosing a model whose provider has no key is the one way to configure
      // an action into silence, so the picker is told rather than left to
      // discover it when somebody tries to build a widget.
      available: provider ? availableProviders()[provider] : false,
    };
  };

  app.get("/api/models", async () => {
    const providers = availableProviders();
    const settings = currentSettings();
    const selected = settings.model;

    return {
      providers,
      /*
       * The provider is the choice above the table: pick one and every task
       * that has not been pinned individually moves with it. Both the stored
       * answer and the one actually in force are sent, because they differ
       * whenever the chosen provider has no key — and the picker has to be
       * able to say that rather than appear to have done nothing.
       */
      providerOptions: PROVIDERS.map((provider) => ({
        ...provider,
        available: providers[provider.id],
      })),
      provider: settings.provider ?? null,
      effectiveProvider: preferredProvider(settings),
      /*
       * What "Default" would actually give, which is not the same as what is
       * in force. Choosing Claude and then reading "Default (Claude)" on the
       * option that would move you back to OpenAI is a label describing the
       * state instead of the choice — so this is resolved with the stored
       * answer taken out.
       */
      defaultProvider: preferredProvider({ provider: null, model: null, models: {} }),
      models: MODELS.map((model) => ({
        ...model,
        // Surfaced so the picker can disable rather than hide — seeing that
        // GPT-4.1 exists but needs a key is more useful than an empty list.
        available: providers[model.provider],
      })),
      selected,
      effective: selected ?? defaultModelId(settings),
      // A model id set in .env cannot be overridden from the UI, so say so
      // rather than letting the picker appear to do nothing.
      pinnedByEnv: Boolean(process.env.DASH_LLM_MODEL),
      tasks: TASKS.map((task) => taskState(task.id, settings)),
      /*
       * What the AI has cost this process, split by which action spent it.
       *
       * Beside the picker deliberately: a per-task choice is a spending
       * decision, and the numbers that would justify it should not be in a
       * different place from the control that acts on them.
       */
      spend: llmSpend(),
      ratesAsOf: RATES_AS_OF,
    };
  });

  app.put<{ Body: unknown }>("/api/models", async (request, reply) => {
    if (!options.settings) {
      return reply.status(400).send({ error: "this server has no settings store" });
    }

    /** The state every write returns, so the picker never re-fetches to agree. */
    const stateOf = (next: Settings, cleared?: { tasks: LlmTask[]; global: boolean }) => ({
      provider: next.provider ?? null,
      effectiveProvider: preferredProvider(next),
      defaultProvider: preferredProvider({ provider: null, model: null, models: {} }),
      selected: next.model,
      effective: next.model ?? defaultModelId(next),
      tasks: TASKS.map((entry) => taskState(entry.id, next)),
      /*
       * What the write had to drop to be true. Nothing else here removes a
       * choice somebody made, so it is said rather than left to be noticed.
       */
      clearedTasks: cleared?.tasks ?? [],
      clearedGlobal: cleared?.global ?? false,
    });

    /*
     * Two writes through one route, distinguished by which key is present:
     * the provider above the table, or a model for the table (globally, or
     * for one task).
     */
    const body = z
      .union([
        z.object({ provider: z.string().max(40).nullable() }),
        z.object({
          model: z.string().min(1).max(120).nullable(),
          /** Absent means the global choice; a task name means only that one. */
          task: z.string().max(40).optional(),
        }),
      ])
      .safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "a model id (or null to clear) is required" });
    }

    if ("provider" in body.data) {
      const wanted = body.data.provider;
      if (wanted !== null && !isProvider(wanted)) {
        return reply
          .status(400)
          .send({ error: `"${wanted}" is not a provider this server knows.` });
      }
      /*
       * A provider with no key is refused rather than stored. Unlike a model
       * choice, this one silently falls back at resolution time, so accepting
       * it would leave the picker reading OpenAI while every call went to
       * Claude.
       */
      if (wanted && !availableProviders()[wanted]) {
        const info = findProvider(wanted);
        return reply.status(400).send({
          error: `${info?.label ?? wanted} needs a ${info?.keyVar}, which this server doesn't have.`,
        });
      }
      const change = options.settings.setProvider(wanted);
      return stateOf(change.settings, {
        tasks: change.clearedTasks,
        global: change.clearedGlobal,
      });
    }

    const { model, task } = body.data;
    if (task !== undefined && !isTask(task)) {
      return reply.status(400).send({ error: `"${task}" is not an action this server performs.` });
    }
    if (model !== null) {
      const provider = providerFor(model);
      if (!provider) {
        return reply.status(400).send({
          error: `"${model}" doesn't look like an Anthropic or OpenAI model id.`,
        });
      }
      if (!availableProviders()[provider]) {
        return reply.status(400).send({
          error: `${model} needs a ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}, which this server doesn't have.`,
        });
      }
    }

    const next = task
      ? options.settings.setTaskModel(task, model)
      : options.settings.setModel(model);

    return stateOf(next);
  });

  // ── catalog ─────────────────────────────────────────────────────────────
  const catalog = options.catalog;

  /*
   * Mapping an API, once, for everyone who ever connects to it.
   *
   * Registered beside the catalog it writes into rather than beside the
   * connections, because the map is a property of the *API* — it needs no
   * connection, no key, and nothing about anybody's account.
   */
  void app.register(
    mapRoutes({
      onRefreshed: (previous, fresh) => {
        for (const connection of store.listConnections()) {
          if (connection.catalog !== previous.id) continue;
          store.putConnection(refreshCatalogConnection(connection, previous, fresh));
          enumerated.delete(connection.id);
          // Inside the loop: a catalog refresh only reaches connections that
          // imported that catalog, and the rest of the board has no reason to
          // refetch.
          queries.invalidate(connection.id);
        }
      },
      catalog,
      llm: (task) => resolveLlm(task),
      // The same SSRF-guarded, allowlist-free entry point discovery uses. A
      // spec is a public document and there is no connection to pin it to.
      fetchDocument: fetchPublicDocument,
    }),
  );

  /*
   * What somebody wants from a connection, and the boards that answer it.
   *
   * Two routes on the catalog and two on the connection, because onboarding
   * has two halves with two lifetimes: how an API divides up describes the API
   * and is shared with everybody who connects it, and which parts one person
   * picked is theirs. See `routes/onboarding.ts`.
   */
  void app.register(
    onboardingRoutes({
      catalog,
      llm: () => resolveLlm("onboarding"),
      getConnection: (id) => store.getConnection(id),
      putConnection: (spec) => store.putConnection(spec),
      getDashboard: (id) => store.getDashboard(id),
      putDashboard: (spec) => store.putDashboard(spec),
      dashboardIds: () => store.listDashboards().map((board) => board.id),
      /*
       * A widget checked during setup is read exactly as its board will read
       * it: the same request, the same key, through the same cache and gate.
       * So the check is also the board's first warm-up. A cached copy served
       * in place of a refusal is reported as the refusal — a check asks
       * whether the widget works now.
       */
      read: async ({ connection, op, params, resolved }) => {
        const resolvedOp = getOp(connection, op);
        if (!resolvedOp) throw new AdapterError(`no operation "${op}"`, { status: 404 });
        registry.addConnection(connection);
        refreshQueryIdentity(connection);
        const request = buildQueryRequest({
          connection: connection.id,
          op: resolvedOp,
          params,
          resolved,
        });
        const outcome = await queries.read({
          key: request.key,
          connection: connection.id,
          maxAgeMs: 5 * 60_000,
          fetcher: (validators) =>
            registry.fetch(connection.id, op, request.overrides, {
              params: request.resolved,
              now: Date.now(),
              resolveSecret: async (keyRef) => keys.get(keyRef),
              ...(validators ? { validators } : {}),
            }),
        });
        if (outcome.outcome === "stale" && outcome.error) {
          throw new AdapterError(outcome.staleReason ?? "refused", {
            status: outcome.error.status ?? 502,
            ...(outcome.error.retryAfter ? { retryAfter: outcome.error.retryAfter } : {}),
          });
        }
        return outcome.body;
      },
      ensureDefaultBoard: (connection) => ensureBoardFor(connection, { evenWhenOnboarding: true }),
    }),
  );

  /**
   * How often each of this connection's endpoints is asked again, and why.
   *
   * Free: the classification is on the catalog entry, the cadences are on
   * disk, and the whole answer is a projection of the two. Ordered so the
   * endpoints a board actually reads come first — those are the ones whose
   * freshness anybody notices, and a list of two hundred is unreadable
   * otherwise.
   */
  app.get<{ Params: { id: string } }>("/api/connections/:id/rhythm", async (request, reply) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) return reply.status(404).send({ error: "no such connection" });

    const personal = rhythms.get(connection.id);
    /*
     * Read from the warm set as it stands now, not from what the keeper has
     * taken stock of: that only happens on a tick, and somebody arriving here
     * seconds after building their boards would be told nothing is kept warm.
     */
    const warmed = new Set(
      keeper
        .currentTargets()
        .filter((target) => target.connection === connection.id)
        .map((target) => target.op),
    );

    const entities = connection.catalog
      ? (options.catalog?.get(connection.catalog)?.entities ?? [])
      : [];
    const nameOf = new Map<string, string>();
    for (const entity of entities) {
      for (const op of opsOfResource(connection, entity.resource)) {
        nameOf.set(op, entity.name.many);
      }
    }

    const decided = decideAll({
      ...rhythmFor(connection),
      ops: connection.ops.map((op) => op.id),
    });

    return {
      connection: connection.id,
      title: connection.title,
      tiers: personal.tiers,
      at: personal.at ?? null,
      /* Whether anybody has ever read this API for rhythm. Absent means every
       * endpoint is sitting on the default rather than on a judgement. */
      classified: Boolean(connection.catalog && options.catalog?.get(connection.catalog)?.rhythm),
      endpoints: decided
        .map((decision) => ({
          ...decision,
          title: connection.ops.find((op) => op.id === decision.op)?.title ?? decision.op,
          records: nameOf.get(decision.op) ?? null,
          /* On a board somebody opens, so its cadence is one they will feel. */
          warmed: warmed.has(decision.op),
        }))
        .sort((a, b) => Number(b.warmed) - Number(a.warmed) || a.op.localeCompare(b.op)),
    };
  });

  /**
   * Move one endpoint to another cadence, or put it back.
   *
   * Stored as an override on *this* connection and nowhere else: the reading
   * it disagrees with is shared with everybody who connects this API, and one
   * person's preference has no business travelling with it.
   */
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/connections/:id/rhythm",
    async (request, reply) => {
      const parsed = z
        .object({
          /** Endpoint id → tier id, or null to go back to the classification. */
          overrides: z.record(z.string().min(1), z.string().min(1).nullable()),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "an endpoint and a cadence are needed" });
      }

      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });

      const personal = rhythms.get(connection.id);
      const known = new Set(personal.tiers.map((tier) => tier.id));
      const refused: string[] = [];

      let current = personal;
      for (const [op, tier] of Object.entries(parsed.data.overrides)) {
        if (!connection.ops.some((one) => one.id === op)) {
          refused.push(`"${op}" is not an endpoint this connection carries.`);
          continue;
        }
        if (tier !== null && !known.has(tier)) {
          refused.push(`"${tier}" is not one of the cadences on offer.`);
          continue;
        }
        current = rhythms.override(connection.id, op, tier);
      }

      /* Written even when nothing moved, so "answered" is recorded and the
       * question is not asked again on the next visit. */
      if (current === personal) current = rhythms.put(connection.id, personal);
      /* A moved cadence applies at the keeper's next tick, not a few seconds on. */
      forgetTiers();

      return {
        tiers: current.tiers,
        overrides: current.overrides,
        at: current.at ?? null,
        notes: refused,
      };
    },
  );

  app.get("/api/catalog", async () => (catalog ? catalog.list() : []));

  app.get<{ Params: { id: string } }>("/api/catalog/:id", async (request, reply) => {
    const entry = catalog?.get(request.params.id);
    if (!entry) return reply.status(404).send({ error: "no such catalog entry" });
    return entry;
  });

  /** Store a locally-derived dialect in the overlay, above the repo seed. */
  app.put<{ Params: { id: string }; Body: unknown }>("/api/catalog/:id", async (request, reply) => {
    if (!catalog) return reply.status(501).send({ error: "no catalog configured" });
    const parsed = catalogEntrySchema.safeParse({
      ...(request.body as Record<string, unknown>),
      id: request.params.id,
    });
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid catalog entry",
        detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    return catalog.put(parsed.data);
  });

  /**
   * Create a connection from a catalog entry — the fast path that turns
   * "I want Stripe" into a working connection without anyone writing JSON.
   */
  app.post<{ Body: unknown }>("/api/connections/from-catalog", async (request, reply) => {
    if (!catalog) return reply.status(501).send({ error: "no catalog configured" });
    const parsed = z
      .object({
        catalogId: z.string().min(1),
        id: z.string().min(1).optional(),
        opIds: z.array(z.string()).optional(),
        /*
         * The wizard sets this: the connection is about to be offered a set
         * of starting boards, so it does not get an empty one first. Absent
         * for a script or an older client, which keep the empty board.
         */
        onboarding: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request", detail: parsed.error.issues });
    }

    const entry = catalog.get(parsed.data.catalogId);
    if (!entry) return reply.status(404).send({ error: "no such catalog entry" });

    /**
     * Connecting the same API twice is legitimate — two Stripe accounts, two
     * repos — so a repeat gets its own id rather than silently overwriting the
     * first connection and taking its key with it.
     */
    let id = parsed.data.id ?? entry.id;
    if (!parsed.data.id) {
      let suffix = 2;
      while (store.getConnection(id)) id = `${entry.id}-${suffix++}`;
    }

    const made = connectionFromCatalog(entry, {
      id,
      ...(parsed.data.opIds ? { opIds: parsed.data.opIds } : {}),
    });
    const connection: ConnectionSpec = parsed.data.onboarding
      ? { ...made, onboarding: onboardingSchema.parse({ status: "pending" }) }
      : made;
    store.putConnection(connection);
    ensureBoardFor(connection);
    registry.addConnection(connection);

    const refs = connectionKeyRefs(connection);
    const ready = !connectionNeedsAuthSetup(connection) && refs.every((ref) => keys.has(ref));
    return {
      ...connection,
      hasKey: ready,
      needsKey: !ready,
    };
  });

  /**
   * Walk the discovery ladder for a URL the user typed.
   *
   * Returns a *proposal* whatever rung answers. Nothing here is saved and
   * nothing is marked verified — the oracle is the validate-and-sample step,
   * because documentation lies and a live 200 does not.
   */
  app.post<{ Body: unknown }>("/api/discover", async (request, reply) => {
    const parsed = z.object({ url: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "a url is required" });

    const result = await discover(parsed.data.url, {
      fetchDocument: async (url) => {
        const response = await fetchPublicDocument(url);
        return { status: response.status, text: response.text, url: response.url };
      },
      catalog: options.catalog,
      llm: resolveLlm("discover"),
      search: resolveSearch(),
    });

    return result;
  });

  /**
   * Read every documented page in a section and merge what they declare.
   *
   * Separate from `/api/discover` on purpose: one request per page against
   * somebody else's documentation site is not something to do speculatively.
   * The discovery result reports the page count and the time it would take,
   * and this runs only once a person has seen those numbers and asked.
   */
  app.post<{ Body: unknown }>("/api/discover/read-index", async (request, reply) => {
    const parsed = z.object({ url: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "a url is required" });

    return readIndex(parsed.data.url, {
      fetchDocument: async (url) => {
        const response = await fetchPublicDocument(url);
        return { status: response.status, text: response.text, url: response.url };
      },
      catalog: options.catalog,
    });
  });

  /*
   * There is no `/api/agent/propose`.
   *
   * It backed a drawer that took an endpoint and had a model propose a binding
   * from a live sample. The concierge does the same job from the capability
   * report — no extra request, and a conversation instead of a one-shot — so
   * the drawer and this route went together. `proposeWidget` stays exported
   * from `@freebirdai/dash-agent` for anyone building on the package.
   */

  /**
   * What each connection has cost, and what the cache saved.
   *
   * Counts only — never what was read — so it carries none of the customer's
   * data and none of the retention questions that come with it.
   */
  app.get("/api/cost", async () => ({
    connections: queries.accounting.all(),
    cache: queries.store.stats(),
  }));

  // ── dashboards ──────────────────────────────────────────────────────────
  app.get("/api/dashboards", async () =>
    store.listDashboards().map((dashboard) => ({
      id: dashboard.id,
      title: dashboard.title,
      description: dashboard.description,
      widgets: dashboard.widgets.length,
      updatedAt: dashboard.updatedAt,
    })),
  );

  app.get<{ Params: { id: string } }>("/api/dashboards/:id", async (request, reply) => {
    const dashboard = store.getDashboard(request.params.id);
    if (!dashboard) return reply.status(404).send({ error: "no such dashboard" });
    // Approval state rides alongside the spec rather than inside it, so the
    // board on the wire stays byte-for-byte the board on disk.
    if (!options.grants) return dashboard;
    return { ...dashboard, approvals: dashboardApprovals(options.grants, dashboard) };
  });

  /**
   * Approve one widget exactly as it currently stands.
   *
   * Deliberately no request body: approving means "this, as saved", and a
   * payload would open the door to approving something other than what the
   * approver was shown.
   */
  app.post<{ Params: { id: string; widgetId: string } }>(
    "/api/dashboards/:id/widgets/:widgetId/approve",
    async (request, reply) => {
      const grants = options.grants;
      if (!grants) return reply.status(404).send({ error: "approvals are not enabled" });
      const dashboard = store.getDashboard(request.params.id);
      if (!dashboard) return reply.status(404).send({ error: "no such dashboard" });
      const widget = dashboard.widgets.find((entry) => entry.id === request.params.widgetId);
      if (!widget) return reply.status(404).send({ error: "no such widget" });
      return approveWidget(grants, dashboard.id, widget);
    },
  );

  /**
   * What a widget on a board can be changed to, and changing it.
   *
   * The whole point of storing the brief. Until this existed a widget's
   * decisions died the moment it was added: the setup card's controls come
   * from a draft, the draft is destroyed on confirm, and the only thing left
   * on a finished widget was how it looked. Changing a column meant deleting
   * the widget and describing it again.
   *
   * Server-side because it needs what the client has not got — the record
   * type, the reach graph, and the compiler — and because answering a control
   * must have exactly one implementation. The same reason `/answer` applies
   * the setup's own answers here rather than in the browser.
   */
  const settingsFor = (dashboardId: string, widgetId: string) => {
    const dashboard = store.getDashboard(dashboardId);
    if (!dashboard) return { ok: false as const, status: 404 as const, error: "no such dashboard" };
    const widget = dashboard.widgets.find((entry) => entry.id === widgetId);
    if (!widget) return { ok: false as const, status: 404 as const, error: "no such widget" };

    /*
     * A widget with no brief is not broken and is not rare: everything built
     * before briefs existed carries none, and so does anything the card
     * re-answered afterwards. It keeps the settings it always had — how it
     * looks — and says so rather than offering controls that would rebuild it
     * from a request nobody made.
     */
    const brief = widget.brief;
    if (!brief) return { ok: true as const, dashboard, widget, brief: null, controls: [] };

    const connection = store.getConnection(
      widget.source?.connection ?? widget.sources[0]?.connection ?? "",
    );
    const entities = connection?.catalog
      ? (options.catalog?.get(connection.catalog)?.entities ?? [])
      : [];
    const entity = entityById(entities, brief.entity);
    /*
     * The record type is gone — re-described, renamed, or the connection
     * removed. Fail closed: presentation only and a plain sentence, never
     * controls derived from a record type nobody can see.
     */
    if (!connection || !entity) {
      return {
        ok: true as const,
        dashboard,
        widget,
        brief,
        controls: [],
        unavailable: "The record type this was built from is no longer described on this API.",
      };
    }

    return {
      ok: true as const,
      dashboard,
      widget,
      brief,
      entity,
      connection,
      entities,
      controls: briefOptions({
        brief,
        entity,
        graph: entityGraph(relatedFor(connection, entities)),
        entities,
      }),
    };
  };

  app.get<{ Params: { id: string; widgetId: string } }>(
    "/api/dashboards/:id/widgets/:widgetId/settings",
    async (request, reply) => {
      const found = settingsFor(request.params.id, request.params.widgetId);
      if (!found.ok) return reply.status(found.status).send({ error: found.error });
      return {
        brief: found.brief,
        controls: found.controls,
        ...(found.unavailable ? { unavailable: found.unavailable } : {}),
      };
    },
  );

  /**
   * One answer, folded into the brief and compiled again.
   *
   * `PUT` rather than `PATCH` because the brief is replaced whole, and because
   * nothing else on this server uses `PATCH`.
   */
  app.put<{ Params: { id: string; widgetId: string }; Body: unknown }>(
    "/api/dashboards/:id/widgets/:widgetId/brief",
    async (request, reply) => {
      const parsed = z
        .object({ stepId: z.string().min(1).max(120), values: z.array(z.string().max(200)).max(40) })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "an answer needs a step and its values" });
      }

      const found = settingsFor(request.params.id, request.params.widgetId);
      if (!found.ok) return reply.status(found.status).send({ error: found.error });
      if (!found.brief || !found.entity || !found.connection) {
        return reply
          .status(409)
          .send({ error: found.unavailable ?? "This widget was not built from a request." });
      }

      const resource = found.connection.resources.find((one) => one.id === found.entity!.resource);
      if (!resource) {
        return reply.status(409).send({ error: "That record type is not one this connection carries." });
      }

      const next = answerBrief(found.brief, parsed.data.stepId, parsed.data.values);
      const compiled = compileBrief({
        brief: next,
        entity: found.entity,
        resource,
        connection: found.connection.id,
        listPath: pathOf(found.connection, resource.listOp),
        related: relatedFor(found.connection, found.entities ?? []),
        /*
         * The widget's own id, which `recompileWidget` also enforces. A fresh
         * one orphans its layout cell — and for a widget in a group, drops the
         * group below two members, which makes the *whole board* unstorable.
         */
        id: found.widget.id,
      });

      if (!compiled.widget) {
        return reply.status(409).send({ error: compiled.errors[0] ?? "That change cannot be built." });
      }

      const widget = recompileWidget(found.widget, compiled.widget);
      const board = {
        ...found.dashboard,
        widgets: found.dashboard.widgets.map((entry) =>
          entry.id === widget.id ? widget : entry,
        ),
      };
      const valid = parseDashboard(board);
      if (!valid.ok || !valid.value) {
        return reply.status(409).send({ error: "That change does not produce a usable board.", detail: valid.errors });
      }

      /*
       * Deliberately no cache invalidation.
       *
       * The cache is keyed on connection + op + params + range + filters. A
       * widget spec cannot change the identity of an upstream response — only
       * the pipeline the browser runs over it. If this edit changed the source
       * params then `queryKey` changed with them and the old entry simply goes
       * unused. Wiping here used to blank every tile on the board, on every
       * connection, each time somebody tweaked one widget in chat: the whole
       * board then refetched cold and collected its own rate limit, with
       * nothing left to fall back on. It also destroyed the cached responses
       * `SetupPreviews` checks drafts against, which is the evidence the
       * preview check exists to read.
       */
      store.putDashboard(valid.value);
      return {
        widget,
        notes: compiled.notes,
        controls: briefOptions({
          brief: next,
          entity: found.entity,
          graph: entityGraph(relatedFor(found.connection, found.entities ?? [])),
          entities: found.entities ?? [],
        }),
      };
    },
  );

  app.delete<{ Params: { id: string; widgetId: string } }>(
    "/api/dashboards/:id/widgets/:widgetId/approve",
    async (request, reply) => {
      const grants = options.grants;
      if (!grants) return reply.status(404).send({ error: "approvals are not enabled" });
      grants.revoke(widgetGrantSubject(request.params.id, request.params.widgetId));
      return { ok: true };
    },
  );

  /**
   * Create a board from a title alone.
   *
   * `PUT /:id` upserts, which means creating one otherwise requires the caller
   * to invent an id — and then two callers (the nav and the assistant) invent
   * them differently and collide. Slugify here, suffix on collision, one rule.
   */
  app.post<{ Body: { title?: string } }>("/api/dashboards", async (request, reply) => {
    const title = (request.body?.title ?? "").trim();
    if (!title) return reply.status(400).send({ error: "a title is required" });
    try {
      const created = createDashboardSpec(title);
      // The stored copy, so the caller leaves with the version to quote in its
      // next `If-Match`. Returning the pre-write spec meant every new board
      // started with no version and its first save could not be guarded.
      return reply.status(201).send(store.getDashboard(created.id) ?? created);
    } catch (error) {
      return reply
        .status(400)
        .send({ error: error instanceof Error ? error.message : "invalid dashboard" });
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/dashboards/:id",
    async (request, reply) => {
      const parsed = dashboardSchema.safeParse({
        ...(request.body as Record<string, unknown>),
        id: request.params.id,
      });
      if (!parsed.success) {
        // Flat, readable messages — this is also what the agent's repair loop reads.
        return reply.status(400).send({
          error: "invalid dashboard",
          detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        });
      }

      /*
       * Two writers, one document.
       *
       * A drag saves the board, and so does the assistant when it adds or
       * removes a widget. Both send the whole spec, so whichever lands second
       * silently erases the other — a widget the chat just added disappears
       * because a drag that started before it finished afterwards.
       *
       * `If-Match` carries the `updatedAt` the client last saw. Sending none
       * keeps the old last-writer-wins behaviour, which is what a script or a
       * first-time write wants.
       */
      const ifMatch = request.headers["if-match"];
      if (typeof ifMatch === "string" && ifMatch !== "") {
        const existing = store.getDashboard(request.params.id);
        const stored = existing?.updatedAt;
        if (stored && stored !== ifMatch) {
          return reply.status(409).send({
            error: "This dashboard changed somewhere else while you were editing it.",
            updatedAt: stored,
          });
        }
      }

      store.putDashboard(parsed.data);
      // The stored copy, so the caller learns the new `updatedAt` to send next
      // time rather than having to re-read the board to find it.
      return store.getDashboard(parsed.data.id) ?? parsed.data;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/dashboards/:id", async (request) => {
    store.deleteDashboard(request.params.id);
    // A board id can be reused; leaving its grants behind would silently
    // pre-approve whatever gets created under the same name next.
    options.grants?.revokeDashboard(request.params.id);
    return { ok: true };
  });

  /* ── chat ───────────────────────────────────────────────────────────── */

  /*
   * FreeBird's chat, mounted on this server.
   *
   * Only when storage was opened — chat is the one feature here with real
   * persistence, and a half-mounted version that 500s on the first message is
   * worse than an absent one. Everything else in this file keeps working
   * without it.
   */
  if (options.chat) {
    const chatDb = options.chat;

    /*
     * Drop the cached registry the moment the board changes.
     *
     * FreeBird caches a resolved registry per tenant for sixty seconds, and
     * the plugin hands back the handle to clear it — which Dash was
     * discarding. The cost is precise and awkward: add a widget by chat and
     * for the next minute the assistant is answering from a roster that does
     * not contain it, so asked about the thing it just made it says it has
     * never heard of it. Assigned after the plugin is built, because the
     * registry callback that needs it is an input to building it.
     */
    let invalidateRegistry: (tenantKey?: string) => void = () => {};

    /**
     * Which board a message is about.
     *
     * Sent as a header by the client because the user can switch dashboards
     * without reloading, and a chat turn is only meaningful against the one
     * actually on screen.
     */
    const dashboardFor = (auth: { extra?: Record<string, unknown> }): DashboardSpec | null => {
      const requested = auth.extra?.["dashboardId"];
      if (typeof requested === "string") {
        const found = store.getDashboard(requested);
        if (found) return found;
      }
      return store.listDashboards()[0] ?? null;
    };

    /*
     * The window the board is actually showing.
     *
     * The browser resolves its range against `controls.anchor` — an instant
     * that only moves when the user acts — so re-resolving here against the
     * server's clock would give the chat a different window from the tiles it
     * is talking about. The client sends what it resolved; the board's own
     * default stands in when it did not.
     */
    const resolvedFor = (dashboard: DashboardSpec, header: unknown): ResolvedParams => {
      const parts = typeof header === "string" ? header.split(":") : [];
      const start = Number(parts[1]);
      const end = Number(parts[2]);
      if (parts.length >= 3 && Number.isFinite(start) && Number.isFinite(end)) {
        return {
          range: {
            start,
            end,
            grain: (parts[3] as TimeRange["grain"]) || defaultGrainFor(start, end),
            preset: (parts[0] as RangePreset) || "custom",
          },
          filters: {},
        };
      }
      return {
        range: resolveRange({
          preset: dashboard.params.defaultRange,
          now: Date.now(),
        }),
        filters: {},
      };
    };

    /**
     * One read, through the same cache and accounting a widget's own request
     * goes through — so a widget the user is looking at is already in there
     * and costs nothing to talk about.
     *
     * `cacheOnly` is what keeps the harness's budget honest: a source chosen
     * *because* it was free must not quietly become a request if the entry
     * expired between choosing and reading. It returns null instead and the
     * search moves on.
     */
    const readForChat = async (input: {
      connection: string;
      op: string;
      params: Readonly<Record<string, string | number | boolean>>;
      resolved: ResolvedParams;
      cacheOnly: boolean;
    }): Promise<ReadOutcome | null> => {
      const spec = store.getConnection(input.connection);
      if (!spec) return null;
      const resolvedOp = getOp(spec, input.op);
      if (!resolvedOp) return null;

      refreshQueryIdentity(spec);
      const {
        key,
        overrides,
        resolved: scoped,
      } = buildQueryRequest({
        connection: input.connection,
        op: resolvedOp,
        params: input.params,
        resolved: input.resolved,
      });

      if (input.cacheOnly) {
        const cached = queries.store.get(key);
        return cached
          ? {
              ok: true as const,
              body: cached.body,
              requests: 0,
              truncated: cached.meta.truncated,
              // Nothing here checks an age, on purpose — but a reply that says
              // "as of forty minutes ago" is honest where a bare number is not.
              ageMs: Math.max(0, Date.now() - cached.storedAt),
            }
          : null;
      }

      registry.addConnection(spec);
      try {
        const outcome = await queries.read({
          key,
          connection: input.connection,
          // An hour: the chat is answering a question about a board, not
          // refreshing it. Forcing a fetch here would spend a request on data
          // the user is already looking at.
          maxAgeMs: 60 * 60_000,
          /*
           * Behind the widgets. A chat turn takes seconds to compose and reads
           * up to eight sources; a tile the reader is staring at must not queue
           * behind that.
           */
          priority: Priority.Background,
          fetcher: (validators) =>
            registry.fetch(input.connection, input.op, overrides, {
              params: scoped,
              now: Date.now(),
              resolveSecret: async (keyRef) => keys.get(keyRef),
              ...(validators ? { validators } : {}),
            }),
        });
        return {
          ok: true as const,
          body: outcome.body,
          requests: outcome.outcome === "hit" || outcome.outcome === "stale" ? 0 : 1,
          truncated: outcome.meta.truncated,
          ...(outcome.outcome === "miss" ? {} : { ageMs: Math.max(0, outcome.ageMs) }),
        };
      } catch (error) {
        /*
         * A refused endpoint is not an error in the conversation — the search
         * moves on. But the *reason* travels with it: the adapter has already
         * phrased 401, 403 and 429 for a person, and "your key works and is not
         * allowed to read this" is the only actionable thing in the reply.
         * Throwing here would end the turn over one unreadable source.
         */
        return {
          ok: false as const,
          reason:
            error instanceof AdapterError ? error.userMessage : `"${input.op}" could not be read.`,
        };
      }
    };

    /*
     * Rotates the response instructions so consecutive replies do not share a
     * skeleton. Held here rather than per call so it actually advances.
     */
    const rotatePrompt = createPromptRotation();

    /**
     * The record the person has open, as this turn's context.
     *
     * Read cache-only: the browser has just drawn it, so the rows are already
     * held, and a chat turn must never quietly buy data merely to work out
     * what somebody is looking at.
     */
    /**
     * Where one of a record type's records is fetched from.
     *
     * A record page calls the record type's own detail endpoint, so this names
     * the request already sitting in the cache when somebody asks about what
     * they are looking at. Resolved from the catalog rather than from a widget,
     * because a record page has no widget behind it.
     */
    const entityDetailFor = (connectionId: string, entityId: string) => {
      const connection = store.getConnection(connectionId);
      if (!connection) return null;
      const entities = connection.catalog
        ? (options.catalog?.get(connection.catalog)?.entities ?? [])
        : [];
      const entity = entityById(entities, entityId);
      if (!entity) return null;
      const resource = connection.resources.find((one) => one.id === entity.resource);
      if (!resource?.detailOp || !resource.detailParam) return null;
      return {
        op: resource.detailOp,
        idParam: resource.detailParam,
        idField: entity.identity?.field ?? null,
        title: entity.name.one,
      };
    };

    const onScreenFocus = async (
      auth: { extra?: Record<string, unknown> },
      dashboards: readonly DashboardSpec[],
      dashboard: DashboardSpec,
      context: ConciergeContext,
    ) => {
      const open = parseView(auth.extra?.["view"]);
      if (!open) return null;
      return focusFromScreen({
        open,
        entityDetail: entityDetailFor,
        handles: workspaceHandles(dashboards, dashboard.id),
        context,
        resolved: resolvedFor(dashboard, auth.extra?.["range"]),
        read: readForChat,
        now: () => Date.now(),
        timeZone: dashboard.params.timeZone,
        rowsOf: (body) =>
          typeof body === "object" && body !== null && !Array.isArray(body)
            ? [body as Record<string, unknown>]
            : Array.isArray(body)
              ? (body.filter((row) => typeof row === "object" && row !== null) as Record<
                  string,
                  unknown
                >[])
              : [],
      });
    };

    /*
     * Where a conversation's current records live.
     *
     * In the chat database, so a follow-up survives a restart — the same
     * scratch table the concierge's draft uses, under its own namespace and
     * scoped by session rather than by board. Identity is passed explicitly
     * because the table folds tenant and user into its primary key, and these
     * rows hold records read off somebody's API.
     */
    const focusStore = new ScratchFocusStore(chatDb.adapter, {
      userId: LOCAL_USER_ID,
    });

    /*
     * One search per question, however many times it is asked for.
     *
     * The inner loop runs up to `maxToolSteps` times, and a model that has
     * just been handed an excerpt rather than a full result will sometimes ask
     * the same question again to see the rest. The prompt tells it not to;
     * this makes it free when it does anyway, which matters because the repeat
     * is not a wasted model call but a whole second search - several calls and
     * real upstream requests against somebody's account.
     *
     * Keyed on the session and the arguments, so a genuinely different question
     * still runs. Entries expire after a few seconds rather than at a turn
     * boundary, because `executeExtraTool` is not told which turn it is in —
     * and the window only has to outlive one inner loop, which is seconds. A
     * user asking the same question again a minute later gets a fresh search,
     * which is what they mean by asking again.
     */
    /**
     * The endpoint's own `rowsPath`, parsed the same way the pipeline parses it.
     *
     * Shared by every tool that turns a response into records, so a malformed
     * path behaves identically wherever it is met: an empty read rather than a
     * thrown turn, and a reply that says what it could not read.
     */
    /**
     * How a connection paginates, so those inputs are never offered as filters.
     *
     * The adapter is already driving them; letting a model set `limit` is an
     * invitation to fight the fetcher, and the resulting "I only got 20" is
     * unattributable from either side.
     */
    const paginationOf = (connection: string): unknown =>
      store.getConnection(connection)?.dialect?.pagination;

    const rowsForOp = (body: unknown, rowsPath: string): Record<string, unknown>[] => {
      try {
        return extractRows(parsePath(rowsPath), body).filter(
          (row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null && !Array.isArray(row),
        );
      } catch {
        return [];
      }
    };

    const ANSWER_MEMO_MS = 20_000;
    const answered = new Map<string, { at: number; value: unknown }>();

    const chatPlugin = createFreeBirdPlugin({
      db: chatDb.adapter,
      llm: () => resolveChatLlm(() => resolveLlm("chat")),

      /*
       * A read-only lookup the model may call on any turn, whose result is
       * handed back to it before it answers.
       *
       * This was a chat *action* first, which cannot work: an action is a
       * confirmed side effect and its result never re-enters the conversation.
       * The model would say "I'll look up what endpoints are available for
       * tasks and work orders" and the turn would end, because from its side
       * nothing came back. Actions change the app; answering a question needs
       * a result mid-turn, which is a different mechanism — and one the engine
       * always had, but which nothing exposed to a host until now.
       */
      extraTools: {
        [LOOK_UP_TOOL]: {
          name: LOOK_UP_TOOL,
          description:
            "Look up what an endpoint returns — its fields, its URL, what it can be filtered " +
            "by. Call this before answering any question about what data is available, rather " +
            "than saying you cannot see it. Reads the stored description of the API and makes " +
            "no request against it.",
          schema: lookUpSchema,
        },
        /*
         * The other half of the same idea, and the more expensive one.
         *
         * `look_up_endpoint` answers "what could this show"; this answers
         * "what does it say". It is the only path from the conversation to
         * the user's actual values, and it is a processing tool for the same
         * reason: an action's result never comes back, so a model calling one
         * to answer a question has nothing to say afterwards.
         */
        [ANSWER_TOOL.name]: ANSWER_TOOL,
        /*
         * The workspace's own version of `look_up_endpoint`. Every widget is
         * registered so it can be named and cited, but only the open tab's
         * carry full knowledge — this is what gets the rest without putting
         * sixty endpoint descriptions in every prompt.
         */
        [LOOK_UP_WIDGET_TOOL.name]: LOOK_UP_WIDGET_TOOL,
        /*
         * One record, in full.
         *
         * The verb that was missing. `answer_from_data` searches; this opens
         * something already identified, which is a different act and a far
         * cheaper one — a collection returns a summary of each record and the
         * record's own endpoint returns everything, so a field absent from
         * rows in hand is usually one request away rather than unavailable.
         *
         * Static description on purpose: the engine takes tool schemas once,
         * and what can actually be opened is listed in the per-turn workspace
         * knowledge instead, so a connection added five minutes ago is usable
         * without a restart.
         */
        [READ_TOOL_NAME]: READ_TOOL,
        /*
         * Narrowing, which is the step between listing everything and opening
         * one record. Without it, finding something means reading a page and
         * hoping it is on it — which is how a search over fifty rows comes to
         * report that a record does not exist when it is on page three.
         */
        [QUERY_TOOL_NAME]: QUERY_TOOL,
        /*
         * The fourth verb, declared and refused.
         *
         * `opDefSchema.method` is `z.literal("GET")` — read-only by
         * construction so that no spec and no generated binding can ever
         * mutate a connected account. This exists so "can you update this?"
         * gets the truth (which record, on which API, and why nothing was
         * sent) instead of an invented capability or a refusal that sounds
         * like a policy when it is a fact about the connection.
         */
        [WRITE_TOOL_NAME]: WRITE_TOOL,
      },
      executeExtraTool: async (name, args, ctx) => {
        /** What a tool is allowed to touch, for this turn's board. */
        const toolDepsFor = (dashboard: DashboardSpec, context: ConciergeContext): ToolDeps => ({
          read: readForChat,
          resolved: resolvedFor(dashboard, ctx.auth.extra?.["range"]),
          rowsOf: rowsForOp,
          rowsPathFor: (op, connection) =>
            contextForConnection(context, connection).shapes[op]?.rowsPath ?? "$",
        });

        if (name === WRITE_TOOL_NAME) {
          const parsed = writeToolSchema.safeParse(args);
          if (!parsed.success) {
            return { error: "write_record needs a `resource` name and an `id`" };
          }
          const bindings = bindingsFor({ context: conciergeContext(), pagination: paginationOf });
          return planWrite({
            binding: bindingFor(bindings, parsed.data.resource),
            resource: parsed.data.resource,
            id: parsed.data.id,
            changes: parsed.data.changes,
          });
        }

        if (name === QUERY_TOOL_NAME) {
          const parsed = queryToolSchema.safeParse(args);
          if (!parsed.success) return { error: "query_records needs a `resource` name" };
          const dashboard = dashboardFor(ctx.auth);
          if (!dashboard) return { error: "there is no dashboard to read from" };
          const context = conciergeContext();
          const bindings = bindingsFor({ context, pagination: paginationOf });
          const binding = bindings.find(
            (entry) => entry.verb === "query" && entry.id === parsed.data.resource,
          );
          if (!binding) {
            const names = bindings
              .filter((entry) => entry.verb === "query")
              .map((entry) => entry.id);
            return {
              error:
                `"${parsed.data.resource}" is not a collection this workspace can narrow. ` +
                `Available: ${names.join(", ") || "nothing"}.`,
            };
          }

          const found = await queryRecords({
            binding,
            deps: toolDepsFor(dashboard, context),
            ...(parsed.data.text ? { text: parsed.data.text } : {}),
            ...(parsed.data.filters ? { filters: parsed.data.filters } : {}),
          });

          /*
           * A query that found records is as strong a statement of subject as
           * a search, so a follow-up about one of them costs nothing.
           */
          if (focusStore && found.records.length > 0) {
            const identity = bindings.find(
              (entry) => entry.verb === "read" && entry.listOp === binding.op,
            );
            await focusStore.put(ctx.sessionId, {
              question: parsed.data.text
                ? `${binding.resource} matching "${parsed.data.text}"`
                : `${binding.resource} records`,
              source: binding.id,
              sourceTitle: binding.title,
              connection: binding.connection,
              op: binding.op,
              idField: identity?.idField ?? null,
              records: found.records.slice(0, 50),
              savedAt: new Date().toISOString(),
            });
          }

          return {
            records: found.records,
            requests: found.requests,
            note: found.note,
            matchedHereNotByTheApi: found.matchedLocally,
            ...(found.warnings.length > 0 ? { caveats: found.warnings } : {}),
          };
        }

        if (name === READ_TOOL_NAME) {
          const parsed = readToolSchema.safeParse(args);
          if (!parsed.success) {
            return { error: "read_record needs a `resource` name and an `id`" };
          }
          const dashboard = dashboardFor(ctx.auth);
          if (!dashboard) return { error: "there is no dashboard to read from" };
          const context = conciergeContext();
          const bindings = bindingsFor({ context });
          // Resolved against what is actually bound, never approximated: an
          // invented resource name is a request against the wrong endpoint.
          const binding = bindingFor(bindings, parsed.data.resource);
          if (!binding) {
            return {
              error:
                `"${parsed.data.resource}" is not a kind of record this workspace can open. ` +
                `Openable: ${bindings.map((entry) => entry.id).join(", ") || "nothing"}.`,
            };
          }

          const opened = await readRecords({
            binding,
            ids: [parsed.data.id],
            deps: toolDepsFor(dashboard, context),
          });

          /*
           * What the conversation is now about. Opening a record by hand is as
           * strong a statement of subject as finding one, so a follow-up about
           * another of its fields costs nothing.
           */
          if (focusStore && opened.records.length > 0) {
            await focusStore.put(ctx.sessionId, {
              question: `the ${binding.resource} ${parsed.data.id}`,
              source: binding.id,
              sourceTitle: binding.title,
              connection: binding.connection,
              op: binding.op,
              idField: binding.idField ?? null,
              records: opened.records.slice(0, 50),
              savedAt: new Date().toISOString(),
            });
          }

          return {
            records: opened.records,
            requests: opened.requests,
            note: opened.note,
            ...(opened.warnings.length > 0 ? { caveats: opened.warnings } : {}),
          };
        }
        if (name === ANSWER_TOOL.name) {
          const dashboard = dashboardFor(ctx.auth);
          if (!dashboard) return { error: "there is no dashboard to read from" };
          const memoKey = `${ctx.sessionId}|${JSON.stringify(args)}`;
          const now = Date.now();
          for (const [key, entry] of answered) {
            if (now - entry.at > ANSWER_MEMO_MS) answered.delete(key);
          }
          const already = answered.get(memoKey);
          if (already) return already.value;
          const dashboards = store.listDashboards();
          const context = conciergeContext();
          const resolved = resolvedFor(dashboard, ctx.auth.extra?.["range"]);
          const outcome = await answerFromData(args, {
            /*
             * The conversation, not the board. What a session is currently
             * about belongs to that session — two people on the same board are
             * asking about different records, and one must not answer from the
             * other's.
             */
            sessionId: ctx.sessionId,
            ...(focusStore ? { focus: focusStore } : {}),
            /*
             * The record on screen outranks whatever the last question put in
             * hand: somebody looking at one record and asking "what is this?"
             * means that one. Costs nothing — the rows were drawn a moment ago
             * and are read cache-only.
             */
            onScreen: await onScreenFocus(ctx.auth, dashboards, dashboard, context),
            /*
             * The cheap tier, deliberately. Ranking sources and judging a
             * sample are reading tasks, and there are several of them per
             * question — the one call the user actually reads is the final
             * response, and that is where the capable model goes.
             */
            llm: options.llm ? resolveLlm("context") : null,
            handles: workspaceHandles(dashboards, dashboard.id),
            dashboards,
            context,
            resolved,
            timeZone: dashboard.params.timeZone,
            now: () => Date.now(),
            read: readForChat,
            // `CacheStore.get` answers a miss with `undefined`, not null.
            isCached: (key) => queries.store.get(key) !== undefined,
            /*
             * The endpoint the query route resolves, so the keys this builds
             * match the ones it wrote. Without it the ranker would report a
             * widget's cached rows as absent and pay for them again.
             */
            opFor: (connection: string, op: string) => {
              const spec = store.getConnection(connection);
              return spec ? getOp(spec, op) : undefined;
            },
            rowsOf: rowsForOp,
            rowsPathFor: (op, connection) =>
              contextForConnection(context, connection).shapes[op]?.rowsPath ?? "$",
          });
          answered.set(memoKey, { at: Date.now(), value: outcome });
          return outcome;
        }
        return { error: `unknown tool "${name}"` };
      },

      /*
       * Rebuilt per turn, from the stored board and whatever has already been
       * read. Deliberately disk-only: a chat message must never trigger an
       * enumeration, which would spend real requests on someone's API as a
       * side effect of typing.
       */
      registry: async (auth) => {
        const dashboard = dashboardFor(auth);
        if (!dashboard) {
          // Parsed rather than cast, so schema defaults fill themselves in and
          // this cannot drift when the dashboard schema gains a field.
          return buildChatRegistry({
            dashboard: dashboardSchema.parse({
              id: "none",
              title: "No dashboard",
              widgets: [],
              layout: { cells: [] },
            }),
            reports: [],
            board: { getDashboard: () => null, putDashboard: () => {} },
          });
        }

        const reports = store.listReports();

        /*
         * Which connections have actually been read. `stale` is the third
         * state and it matters: a report that no longer matches the endpoints
         * is not the same as never having read one, and the assistant should
         * be able to say which.
         */
        const connections = store.listConnections().map((connection) => {
          const report = store.getReport(connection.id);
          const stale = report !== null && isStale(report, connection);
          return {
            id: connection.id,
            title: connection.title,
            read: report !== null && !stale,
            stale,
          };
        });

        return buildChatRegistry({
          dashboard,
          reports,
          connections,
          /*
           * Every question the guided setup can ask, derived from disk alone.
           *
           * No request is made to build this — the whole conversation can be
           * planned from what enumeration already learned, and the reads it
           * needs stay separate, priced and consented.
           */
          concierge: {
            context: conciergeContext(),
            /*
             * Loaded once, here, and handed to the knowledge block as a
             * snapshot. The actions read the store directly instead, because
             * the model may answer several questions inside one turn and each
             * has to see the answer before it.
             */
            draft: await drafts.get(dashboard.id),
            getDraft: () => drafts.get(dashboard.id),
            putDraft: (draft) => drafts.put(dashboard.id, draft),
            clearDraft: () => drafts.clear(dashboard.id),
            getDashboard: () => store.getDashboard(dashboard.id),
            putDashboard: (spec) => store.putDashboard(spec),
            onChanged: () => invalidateRegistry(dashboard.id),
            readConnection,
            checkPreview: (widgets) => previews.failure(widgets),
            previewStatus: (widget) => previews.status(widget).status,
            /*
             * What opening one record shows. Reads nothing upstream — every
             * field and every related collection is already known from the
             * map and whatever has been read.
             */
            ...(options.llm ? { planDetail: planDetailFor } : {}),
            rememberNarrowing: async (entry) => {
              narrowings.put(entry.connection, {
                op: entry.op,
                field: entry.field,
                values: [...entry.values],
                phrase: entry.phrase,
                ...(entry.filterParam ? { filterParam: entry.filterParam } : {}),
                confirmedAt: new Date().toISOString(),
              });
            },
            /*
             * Reading records to find out what a word means in this account.
             *
             * The whole reason this exists: "maintenance" is not in any schema
             * — it is a value somebody typed when they set the account up, and
             * the only way to know which records carry it is to look at some.
             *
             * The saved answer is checked first, so the second widget about
             * maintenance costs nothing and asks nothing.
             */
            ...(options.llm
              ? {
                  narrow: async ({ op, phrase }: { op: string; phrase: string }) => {
                    const context = contextForConnection(
                      conciergeContext(),
                      (await drafts.get(dashboard.id))?.connection,
                    );
                    const matches = context.ops.filter((entry) => entry.id === op);
                    const owner = matches.length === 1 ? matches[0]?.connection : undefined;
                    const saved = owner
                      ? findNarrowing(narrowings.list(owner), { op, phrase })
                      : null;
                    if (saved) {
                      return {
                        field: saved.field,
                        values: saved.values,
                        all: saved.values.map((value) => ({ value, count: 0 })),
                        reason: `You confirmed this before for "${saved.phrase}".`,
                        ...(saved.filterParam ? { filterParam: saved.filterParam } : {}),
                        notes: [],
                      };
                    }

                    const model = resolveLlm("narrow");
                    const connection = owner ? store.getConnection(owner) : null;
                    if (!model || !connection) {
                      return { field: null, values: [], all: [], reason: "", notes: [] };
                    }

                    const plan = await planNarrowing({
                      llm: model,
                      phrase,
                      op,
                      context,
                      fetchRows: async (opId) => {
                        const target = getOp(connection, opId);
                        if (!target) throw new Error(`no endpoint named "${opId}"`);
                        const result = await upstream(connection.id, () =>
                          registry.fetch(
                            connection.id,
                            opId,
                            {},
                            {
                              params: {
                                range: resolveRange({ preset: "30d", now: Date.now() }),
                                filters: {},
                              },
                              now: Date.now(),
                              resolveSecret: async (keyRef) => keys.get(keyRef),
                            },
                          ),
                        );
                        return result.body;
                      },
                    });

                    return {
                      field: plan.field,
                      values: plan.proposed,
                      all: plan.values.map((entry) => ({
                        value: entry.value,
                        count: entry.count,
                      })),
                      reason: plan.proposedReason || plan.fieldReason,
                      ...(plan.filterParam ? { filterParam: plan.filterParam } : {}),
                      notes: plan.notes,
                    };
                  },
                }
              : {}),
            /*
             * The one model call that chooses the records and says what the
             * widget is for. Omitted entirely when there is no model, which is
             * what makes the card fall back to asking rather than to failing.
             */
            ...(options.llm
              ? {
                  propose: async (intent: string) => {
                    const model = resolveLlm("widget");
                    if (!model) return { patch: {}, reason: "", notes: [], ambiguities: [] };

                    /*
                     * Entity-first, and now the only way in.
                     *
                     * It is deliberately only the *decisions* that moved: the
                     * card, its questions and its confirm step read a patch,
                     * and a patch is what this still produces. What changed is
                     * that "show me X filtered by Y" is settled as a list with
                     * a filter strip before a patch is written, where the
                     * older path could only express it as a grouping and so
                     * answered with a chart.
                     *
                     * Across every API whose records have been described, not
                     * just one. A workspace with a second connection used to
                     * fall straight back to picking endpoints by hand — the
                     * brief could only ever see one roster, so two made it
                     * useless rather than merely harder.
                     */
                    const described = store.listConnections().flatMap((entry) => {
                      const records = entry.catalog
                        ? (options.catalog?.get(entry.catalog)?.entities ?? [])
                        : [];
                      return records.length > 0
                        ? [{ connection: entry.id, title: entry.title, entities: records, entry }]
                        : [];
                    });

                    if (described.length > 0) {
                      const candidates = briefCandidates(described);
                      const written = await writeBrief(model, { intent, candidates });
                      const picked = written.brief
                        ? resolveCandidate(candidates, written.brief.entity)
                        : null;
                      const source = picked
                        ? described.find((one) => one.connection === picked.connection)
                        : undefined;
                      const chosen = picked && source
                        ? entityById(source.entities, picked.recordType)
                        : undefined;
                      const resource = chosen && source
                        ? source.entry.resources.find((one) => one.id === chosen.resource)
                        : undefined;

                      if (written.brief && picked && source && chosen && resource) {
                        const mapped = patchFromBrief({
                          /*
                           * The record type's own id, not the handle the model
                           * copied — the handle is qualified on collision and
                           * means nothing to the compiler.
                           */
                          brief: { ...written.brief, entity: chosen.id },
                          entity: chosen,
                          resource,
                          connection: source.connection,
                          listPath: pathOf(source.entry, resource.listOp),
                          related: relatedFor(source.entry, source.entities),
                          id: chosen.id,
                        });
                        /*
                         * A patch with no endpoint is one that did not compile,
                         * and saying so beats handing the card an answer it
                         * cannot build from.
                         */
                        if (mapped.patch.endpoint) {
                          /*
                           * The other things asked for, each compiled the same
                           * way and carried as a part of the same setup.
                           *
                           * Parts rather than separate builds because that is
                           * what everything downstream already understands: one
                           * preview showing all of them, one Add, the
                           * arrangement chips, and — since a part now carries
                           * its own brief and record type — settings per widget
                           * afterwards. A request naming two collections is two
                           * widgets, and they arrive together or not at all.
                           */
                          const parts = written.plus.flatMap((extra) => {
                            const also = resolveCandidate(candidates, extra.entity);
                            const from = also
                              ? described.find((one) => one.connection === also.connection)
                              : undefined;
                            const record = also && from
                              ? entityById(from.entities, also.recordType)
                              : undefined;
                            const holds = record && from
                              ? from.entry.resources.find((one) => one.id === record.resource)
                              : undefined;
                            if (!also || !from || !record || !holds) return [];
                            const built = patchFromBrief({
                              brief: { ...extra, entity: record.id },
                              entity: record,
                              resource: holds,
                              connection: from.connection,
                              listPath: pathOf(from.entry, holds.listOp),
                              related: relatedFor(from.entry, from.entities),
                              id: record.id,
                            });
                            return built.patch.endpoint ? [built.patch] : [];
                          });

                          /*
                           * The other reading, resolved but not compiled.
                           *
                           * Resolved here because this is the only place that
                           * can: the model names a record type by a handle
                           * that is qualified on collision, and a swap two
                           * clicks later has no roster to look it up in.
                           * Compiled only if somebody takes it — it is ignored
                           * on almost every setup, and paying for the compile
                           * every time to save it once is the wrong trade.
                           */
                          const otherReading = (() => {
                            const other = written.alternative;
                            if (!other) return null;
                            const also = resolveCandidate(candidates, other.brief.entity);
                            const from = also
                              ? described.find((one) => one.connection === also.connection)
                              : undefined;
                            const record = also && from
                              ? entityById(from.entities, also.recordType)
                              : undefined;
                            if (!record) return null;
                            /*
                             * Parsed on the way to storage, which is also what
                             * turns the compiler's readonly view of a brief
                             * into the shape the draft holds. A brief that
                             * does not survive its own schema is one the swap
                             * could not have compiled anyway.
                             */
                            const parsed = widgetBriefSchema.safeParse({
                              ...other.brief,
                              entity: record.id,
                            });
                            return parsed.success
                              ? { label: other.label, brief: parsed.data }
                              : null;
                          })();

                          return {
                            /*
                             * The other reading, carried through as the phrase
                             * somebody would recognise. It was written by the
                             * same call that wrote the brief and was being
                             * dropped here, so a genuine fork in the request
                             * reached nobody.
                             */
                            ...(otherReading ? { alternative: otherReading } : {}),
                            patch: {
                              ...mapped.patch,
                              ...(parts.length > 0
                                ? {
                                    parts,
                                    /*
                                     * Shown together, because being asked for
                                     * together is what makes them one answer.
                                     * Which arrangement is the reader's, and
                                     * the chips on the card offer the rest.
                                     */
                                    group: {
                                      title: [chosen.name.many, ...written.plus.map((one) => one.title ?? "")]
                                        .filter(Boolean)
                                        .join(" and ")
                                        .slice(0, 120),
                                    },
                                  }
                                : {}),
                            },
                            reason: written.reason,
                            notes: mapped.notes,
                            ambiguities: [],
                          };
                        }
                        /*
                         * Whatever the compiler said, in its own words.
                         *
                         * A generic "could not build" over a brief that
                         * compiled is worse than saying nothing: the reason is
                         * usually specific and already written. The fallback
                         * sentence is only for the case where nothing
                         * explained itself.
                         */
                        const said = [...mapped.errors, ...mapped.notes];
                        return {
                          patch: {},
                          reason: "",
                          notes:
                            said.length > 0
                              ? said
                              : [
                                  `I could not build a widget of ${chosen.name.many} from what this API offers.`,
                                ],
                          ambiguities: [],
                        };
                      }
                      return {
                        patch: {},
                        reason: "",
                        notes: [
                          written.error
                            ? `I could not work out which records this is about: ${written.error}`
                            : "I could not work out which kind of record this is about.",
                        ],
                        ambiguities: [],
                      };
                    }

                    /*
                     * No record types, so nothing to build from.
                     *
                     * Describing an API happens once, when it is connected, so
                     * reaching this means that pass has not run or did not
                     * finish — and the answer is to finish it rather than to
                     * fall back to hunting through two hundred endpoints named
                     * "Retrieve all X". That fallback is what produced the
                     * failure this whole path replaced: asked to *see* records
                     * narrowed by something, it could only express a grouping,
                     * and answered with a chart.
                     */
                    return {
                      patch: {},
                      reason: "",
                      notes: [
                        "I do not know what kinds of record this API has yet — that is read once, from Connections → Records.",
                      ],
                      ambiguities: [],
                    };
                  },
                }
              : {}),
          },
          allDashboards: store
            .listDashboards()
            .map((board) => ({ id: board.id, title: board.title })),
          /*
           * The whole workspace, widgets included. `allDashboards` answers
           * "what tabs do I have"; this is what makes a widget on one of them
           * nameable, citable and openable without switching to it first.
           */
          workspace: store.listDashboards(),
          /*
           * What they are looking at, so the assistant can talk about it. Free
           * — the record is resolved from rows the browser already drew.
           */
          onScreen: [
            describeScreen({
              tab: dashboard.title,
              open: parseView(auth.extra?.["view"]),
              record: await onScreenFocus(
                auth,
                store.listDashboards(),
                dashboard,
                conciergeContext(),
              ),
            }),
            /*
             * And what they have filtered it down to.
             *
             * A widget's rows rebuild identically here whatever the reader
             * picked — a facet never reaches the API — so without this the
             * assistant answers over every row while the person asking can see
             * a fraction of them. Empty, and absent from the prompt, whenever
             * nothing is filtering.
             */
            describeFilters(
              parseFilters(auth.extra?.["filters"]),
              (widgetId) =>
                store
                  .listDashboards()
                  .flatMap((board) => board.widgets)
                  .find((widget) => widget.id === widgetId)?.title,
            ),
          ]
            .filter((line) => line.length > 0)
            .join("\n\n"),
          /*
           * What can be opened in full. Derived from every connected API's own
           * map, so this grows when somebody connects something and needs no
           * restart — unlike the tool schema, which the engine takes once.
           */
          records: [
            readRoster(bindingsFor({ context: conciergeContext(), pagination: paginationOf })),
            queryRoster(bindingsFor({ context: conciergeContext(), pagination: paginationOf })),
          ].join("\n\n"),
          board: {
            getDashboard: () => store.getDashboard(dashboard.id),
            getDashboardById: (id) => store.getDashboard(id),
            putDashboard: (spec) => store.putDashboard(spec),
            onChanged: () => invalidateRegistry(dashboard.id),
            createDashboard: (title) => createDashboardSpec(title),
            deleteDashboard: (id) => {
              store.deleteDashboard(id);
            },
          },
        });
      },

      /*
       * A concrete identity, always.
       *
       * The Postgres adapter scopes with `.$if(!!auth.userId, …)`, so a blank
       * auth context silently turns every query into "return everything". This
       * is single-user today; when it stops being, this is the seam that has
       * to change rather than a query somewhere deep in the adapter.
       */
      getAuthContext: (request: unknown) => {
        const headers = (request as { headers?: Record<string, unknown> })?.headers ?? {};
        return {
          userId: LOCAL_USER_ID,
          extra: {
            dashboardId: headers["x-dash-dashboard"],
            /*
             * The window the board resolved, not one resolved here. The
             * browser anchors its range to an instant that only moves when the
             * user acts; re-resolving against the server's clock would have
             * the chat describing a different window from the tiles.
             */
            range: headers["x-dash-range"],
            /** What is on screen, when it is finer than the board. */
            view: headers["x-dash-view"],
            /** Which widgets the reader narrowed with a filter strip. */
            filters: headers["x-dash-filters"],
          },
        };
      },

      /*
       * Cache the resolved registry per dashboard, not globally.
       *
       * The registry cache is keyed by tenant, and the default key reads
       * `orgId`/`extra.tenantId` — both absent here, so every request collapsed
       * onto one `__default__` entry. The first board to populate it was then
       * served to every other board for the next sixty seconds: ask about a
       * widget on one dashboard while another's registry is cached and the
       * assistant truthfully reports it has never heard of it.
       */
      tenantKey: (auth) => {
        const id = auth.extra?.["dashboardId"];
        return typeof id === "string" && id.length > 0 ? id : "__none__";
      },

      // Dash owns its own grid. FreeBird's layout solver would fight
      // `DashboardGrid` for control of the same cells.
      enablePlanLayout: false,
      citations: { enabled: true },

      /*
       * One structured question, where guessing would waste their time.
       *
       * Off everywhere by default because it changes the shape of a turn — the
       * reply can be a card rather than prose — and Dash renders one, so it is
       * on here. What it is *for* is narrow and stated in the prompt: a fork
       * where the readings produce different widgets. Asked about anything
       * with a sensible default it becomes a wizard, which is the thing the
       * whole setup card exists to not be.
       */
      askUser: { enabled: true },

      /*
       * One generated reply per turn, and no other writer.
       *
       * `"fallback"` — the default — lets whatever prose the model produced
       * mid-loop be the reply, and prints a canned sentence when there was
       * none. That is how a turn that did nothing came to read exactly like
       * one that worked. Under `"always"` the loop's prose is a draft nobody
       * sees, every deterministic conclusion is an input, and one final call
       * writes what the user reads.
       */
      finalReply: {
        mode: "always",
        /*
         * The one call the user actually reads, on the better model.
         *
         * The loop runs on `chat` and the search on `context`, both cheap,
         * because routing and reading are what the cheap model measured well
         * at. Writing the answer is the judgement call, and it is the only
         * part anybody sees — without this it silently inherited the loop's
         * model and the whole per-task split stopped at the last step.
         */
        llm: () => resolveChatLlm(() => resolveLlm("respond")),
        render: (context) =>
          renderDashReply(context, {
            sessionId: context.sessionId,
            rotate: rotatePrompt,
          }),
      },
      /*
       * Well above the 6000-character default.
       *
       * Each widget contributes its endpoint, its row noun and its field list,
       * which is roughly 350 characters — so a seventeen-widget board lands
       * within a whisker of the default and the last widgets are silently
       * truncated out of the prompt. Being asked about a widget the model was
       * never shown is exactly the confidently-wrong answer to avoid.
       */
      knowledgeContext: { maxChars: 24_000 },
      // No email adapter, so no digests; the worker is not running either.
      scheduler: "external",
      systemPrompt: CHAT_SYSTEM_PROMPT,
    });

    invalidateRegistry = (tenantKey) => chatPlugin.freebird.invalidateRegistry(tenantKey);
    app.register(chatPlugin, { prefix: "/freebird" });
  }

  return app;
};
