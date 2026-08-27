import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, AdapterError, RestAdapter, type HttpFetch } from "@freebirdai/dash-adapters";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { InferredShape } from "@freebirdai/dash-agent";
import { inferShape, mapReviewProposal, reviewSuggestions, suggestWidgets } from "@freebirdai/dash-agent";
import type { ConnectionSpec, DashboardSpec, ResolvedParams } from "@freebirdai/dash-spec";
import { authKeyRefs, catalogEntrySchema, connectionSchema, dashboardSchema, defaultGrainFor, findNarrowing, getOp, isStale, opDefSchema, pathParamNames, queryKey, resolveRange, resourceSchema, statusTone } from "@freebirdai/dash-spec";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { createFreeBirdPlugin } from "@freebirdai/server/fastify";
import {
  type AnalyseOptions,
  type SampleFn,
  analyseConnection,
  analyseStructure,
  applyPairings,
  estimateEnumeration,
  fromReport,
  toReport,
  verifyPairings,
  withVerifiedParams,
} from "./capabilities.js";
import type { ChatDb } from "./chat/db.js";
import { resolveChatLlm } from "./chat/llm-bridge.js";
import {
  LOOK_UP_TOOL,
  lookUpEndpoint,
  lookUpSchema,
} from "./chat/concierge-actions.js";
import { buildChatRegistry } from "./chat/registry.js";
import { buildConciergeContext } from "./concierge/context.js";
import { planDetailSetup } from "./concierge/detail.js";
import type { DetailPlanRequest, DetailSetup } from "./concierge/detail.js";
import { planNarrowing } from "./concierge/drilldown.js";
import { proposeSetup } from "./concierge/propose.js";
import { NarrowingStore } from "./narrowings.js";
import { MemoryDraftStore, ScratchDraftStore, type DraftStore } from "./concierge/store.js";
import { CatalogStore, connectionFromCatalog } from "./catalog.js";
import { discover, readIndex } from "./discovery/index.js";
import type { SearchProvider } from "./discovery/search.js";
import {
  type ModelChoices,
  availableProviders,
  defaultModelId,
  llmSpend,
  modelForTask,
  sourceForTask,
} from "./llm.js";
import {
  type LlmTask,
  MODELS,
  TASKS,
  type TaskInfo,
  findTask,
  isTask,
  providerFor,
} from "./models.js";
import { RATES_AS_OF } from "./pricing.js";
import { BlockedUrlError, fetchPublicDocument, guardedFetch } from "./safe-fetch.js";
import type { PartRegistry } from "@freebirdai/dash-parts";
import { partsRoutes } from "./routes/parts.js";
import { conciergeRoutes } from "./routes/concierge.js";
import { mapRoutes } from "./routes/map.js";
import type { SettingsStore } from "./settings.js";
import { QueryCache, clampMaxAge } from "./cache/queryCache.js";
import type { CacheStore } from "./cache/store.js";
import { waitPhrase } from "./cache/cooldown.js";
import { SpecStore } from "./store.js";
import { KeyStore } from "./vault.js";

export interface BuildServerOptions {
  readonly store: SpecStore;
  readonly keys: KeyStore;
  readonly catalog?: CatalogStore;
  /**
   * Where confirmed narrowings are kept, per connection.
   *
   * Absent means a drill-down still works and simply asks again next time —
   * the answers are a cache of the user's own confirmations, not a dependency.
   */
  readonly narrowings?: NarrowingStore;
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

const CHAT_SYSTEM_PROMPT = [
  "You are the assistant inside FreeBird Dash, a dashboard over the user's own APIs.",
  "",
  "You are always given the dashboard's full contents. Two lists appear in the",
  "knowledge for the component named after the dashboard, and they mean different",
  "things:",
  "",
  '  - "ON THIS DASHBOARD NOW" — widgets that exist. This is the complete list;',
  "    there is no other widget you have not been told about. Answer questions",
  "    about what is on the dashboard directly from it, and match the user's",
  "    wording against these titles rather than asking them for an id.",
  '  - "NOT YET CREATED" — ready-made widgets that do not exist yet, each with the',
  "    id `add_widget` expects. These are for browsing: offer them when somebody",
  "    asks what they could look at. When they describe something specific, build",
  "    it instead — see BUILDING A WIDGET below. A ready-made offer is a card",
  "    saying \"apply this?\"; building gives them the widget itself to adjust.",
  "",
  "Never say you cannot see the dashboard: if a widget is not in the first list,",
  "it is genuinely not there — say so, and offer the closest thing from the second.",
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
  "Never invent an id. Keep answers short and concrete.",
].join("\n");

/** The real transport, wrapped in the SSRF guard and the host allowlist. */
const nodeHttp: HttpFetch = async (url, init, allowedHost) => {
  const result = await guardedFetch(url, init, allowedHost);
  return {
    status: result.status,
    text: result.text,
    url: result.url,
    header: (name) => result.headers.get(name),
  };
};

const rangeSchema = z.object({
  preset: z
    .enum(["1h", "24h", "7d", "30d", "90d", "12mo", "ytd", "custom"])
    .default("30d"),
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
});

export const buildServer = (options: BuildServerOptions): FastifyInstance => {
  const { store, keys } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_000_000 });

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
  const queries = new QueryCache(options.cache ? { store: options.cache } : {});

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
  const enumerated = new Map<string, { at: number; value: Awaited<ReturnType<typeof analyseConnection>>; shapes: Record<string, InferredShape> }>();
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

      const result = await registry.fetch(connection.id, op.id, query, {
        params: { range: resolveRange({ preset: "30d", now: Date.now() }), filters },
        now: Date.now(),
        resolveSecret: async (keyRef) => keys.get(keyRef),
      });
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
    if (!refresh && cached && Date.now() - cached.at < ENUMERATION_TTL) return cached;

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
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "board";

    const taken = new Set(store.listDashboards().map((board) => board.id));
    let id = base;
    for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;

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

  const ensureBoardFor = (connection: { id: string; title: string }): void => {
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
    const refs = authKeyRefs(connection.auth);
    return refs.length === 0 ? !connection.authRequired : refs.every((ref) => keys.has(ref));
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
      const { value } = await enumerate(connection, false);
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

  void app.register(
    conciergeRoutes({
      drafts,
      context: conciergeContext,
      planDetail: planDetailFor,
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

  // ── connections ─────────────────────────────────────────────────────────
  //
  // A connection is public except for its key: responses report `hasKey`,
  // never the secret, so a leaked spec file or a screenshotted API response
  // is worthless.
  const publicConnection = (connection: ReturnType<SpecStore["getConnection"]>) => {
    if (!connection) return null;
    const refs = authKeyRefs(connection.auth);
    // `authRequired` with no auth style chosen yet is not "ready" — the key
    // exists somewhere, we just have not been told where it goes.
    const hasKey = refs.length === 0 ? !connection.authRequired : refs.every((ref) => keys.has(ref));
    /*
     * What this API's fields are called, resolved rather than copied.
     *
     * The lexicon is a fact about the API, so it lives on the catalog entry
     * with the relations and is looked up here on every read instead of being
     * written onto the stored connection. That way re-running the labelling
     * pass is live for every connection to that API at once, and there is one
     * copy to correct rather than one per person who connected.
     *
     * Empty for a connection made by hand against an API nothing has mapped,
     * which every renderer already handles: they fall back to the mechanical
     * label, which is what the product showed before this existed.
     */
    const labels = connection.catalog
      ? (options.catalog?.get(connection.catalog)?.labels ?? {})
      : {};
    return { ...connection, hasKey, labels };
  };

  app.get("/api/connections", async () =>
    store.listConnections().map((connection) => publicConnection(connection)),
  );

  app.get<{ Params: { id: string } }>("/api/connections/:id", async (request, reply) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) return reply.status(404).send({ error: "no such connection" });
    return publicConnection(connection);
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/connections/:id",
    async (request, reply) => {
      const parsed = connectionSchema.safeParse({
        ...(request.body as Record<string, unknown>),
        id: request.params.id,
      });
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid connection", detail: parsed.error.issues });
      }
      store.putConnection(parsed.data);
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
      if (connection.auth.type === "none") {
        return reply.status(400).send({ error: "this connection does not use a key" });
      }
      const refs = authKeyRefs(connection.auth);

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
      // Echo only the fact that it worked. Never the key, not even truncated.
      return { ok: true, hasKey: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/connections/:id/key", async (request, reply) => {
    const connection = store.getConnection(request.params.id);
    if (!connection) return reply.status(404).send({ error: "no such connection" });
    for (const ref of authKeyRefs(connection.auth)) keys.delete(ref);
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

    const opId = connection.validateOpId ?? connection.ops[0]?.id;
    if (!opId) return reply.status(400).send({ error: "this connection has no operations to test" });

    const params: ResolvedParams = {
      range: resolveRange({ preset: "24h", now: Date.now() }),
      filters: {},
    };

    try {
      const result = await registry.fetch(connection.id, opId, {}, {
        params,
        now: Date.now(),
        resolveSecret: async (keyRef) => keys.get(keyRef),
      });
      const summary = Array.isArray(result.body)
        ? `${result.body.length} item(s)`
        : typeof result.body === "object" && result.body !== null
          ? `${Object.keys(result.body).length} field(s)`
          : "a value";
      return {
        ok: true,
        // Descriptive only — the caller supplies the "Connected." so the two
        // do not end up concatenated into "Connected. Connected. …".
        message: `${connection.title} responded with ${summary}.`,
        pages: result.meta.pages,
        truncated: result.meta.truncated,
      };
    } catch (error) {
      const adapterError = error instanceof AdapterError ? error : null;

      /*
       * A 403 is a pass, and this is the whole point of validating.
       *
       * The question this step asks is "do these credentials work?" — and a
       * 403 has already answered it: the API identified the caller and then
       * declined *this resource*. The credential is proven. Reporting failure
       * here strands somebody whose key is fine behind a wizard step they can
       * never satisfy, which is exactly what happened: the endpoint picked for
       * validation belonged to a product module the account was not licensed
       * for, so verification failed forever while every other endpoint worked.
       *
       * Which endpoint was refused is worth saying, because it is genuinely
       * useful — but it is a note, not a failure.
       */
      if (adapterError?.status === 403) {
        return {
          ok: true,
          forbidden: opId,
          message:
            `The key works — ${connection.title} accepted it. It will not allow access to ` +
            `"${opId}", which usually means that endpoint needs a scope this key does not ` +
            `have, or belongs to a module this account does not use. Other endpoints are ` +
            `unaffected.`,
        };
      }

      return reply.status(adapterError?.status ?? 502).send({
        ok: false,
        error: adapterError?.userMessage ?? "That connection could not be reached.",
      });
    }
  });

  // ── query ───────────────────────────────────────────────────────────────
  app.post<{ Body: unknown }>("/api/query", async (request, reply) => {
    const parsed = querySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query", detail: parsed.error.issues });
    }
    const { connection, op, params, range, filters } = parsed.data;

    const spec = store.getConnection(connection);
    if (!spec) return reply.status(404).send({ error: `no connection "${connection}"` });
    const resolvedOp = getOp(spec, op);
    if (!resolvedOp) return reply.status(404).send({ error: `no operation "${op}"` });
    registry.addConnection(spec);

    /*
     * Route each supplied input to the channel that can actually consume it.
     *
     * A caller sends one flat bag of values and should not have to know that a
     * path segment is filled by a `{{param.x}}` token read from `filters`,
     * while everything else is a query-string override. The op declares which
     * of its parameters live in the path, so the split is made here — the only
     * side that has both the values and the endpoint's contract.
     */
    const pathBound = new Set([
      ...pathParamNames(resolvedOp.path),
      ...resolvedOp.params.filter((param) => param.in === "path").map((param) => param.name),
    ]);

    const overrides: Record<string, string | number | boolean> = {};
    const inputs: Record<string, string | number | boolean> = { ...filters };
    for (const [name, value] of Object.entries(params)) {
      if (pathBound.has(name)) inputs[name] = value;
      else overrides[name] = value;
    }

    /*
     * The caller's window wins whenever it sent one.
     *
     * `resolveRange` only honours explicit bounds for the "custom" preset; for
     * "30d" it recomputes `end = now`. The browser has already resolved its
     * window against `controls.anchor` — an instant that deliberately only
     * moves when the user acts — so re-resolving here against the server's
     * clock gave two widgets fetched a second apart two different windows,
     * defeating the anchor. It also made every cache key unique, since the
     * window shifted by a millisecond on each request.
     */
    const explicit = range.start !== undefined && range.end !== undefined;
    const resolved: ResolvedParams = {
      range: explicit
        ? {
            start: range.start as number,
            end: range.end as number,
            grain: range.grain ?? defaultGrainFor(range.start as number, range.end as number),
            preset: range.preset,
          }
        : resolveRange({ preset: range.preset, now: Date.now(), grain: range.grain }),
      filters: inputs,
    };

    /*
     * One identity for the browser's dedupe cache and this one. `queryKey`
     * lives in `@freebirdai/dash-spec` precisely so there is no second implementation to
     * drift — two that disagreed would serve one widget the rows of another.
     */
    const key = queryKey(connection, op, overrides, resolved);

    try {
      const outcome = await queries.read({
        key,
        connection,
        maxAgeMs: clampMaxAge(parsed.data.maxAgeMs),
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
          cache: outcome.outcome,
          ageMs: Number.isFinite(outcome.ageMs) ? outcome.ageMs : 0,
          ...(outcome.staleReason ? { staleReason: outcome.staleReason } : {}),
        },
      };
    } catch (error) {
      // The cache re-throws the adapter's own error, which is already phrased
      // for a person; the generic handler below would flatten it to a 500.
      if (error instanceof AdapterError) {
        return reply
          .status(error.status === 429 ? 429 : 502)
          .send({ error: error.message, userMessage: error.userMessage });
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
    const refs = authKeyRefs(connection.auth);
    // `authRequired` with no auth style chosen yet is not "ready" — the key
    // exists somewhere, we just have not been told where it goes.
    const hasKey = refs.length === 0 ? !connection.authRequired : refs.every((ref) => keys.has(ref));
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
    if (connection) for (const ref of authKeyRefs(connection.auth)) keys.delete(ref);
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
   * What is worth building here, in sentences.
   *
   * Deterministic: no model is involved. It reads the same enumeration
   * `/capabilities` produces — shared, so opening the drawer does not spend a
   * second round of requests on someone else's API — and emits real widget
   * specs with a plain-English rationale attached. A chat turn later becomes a
   * third author of the same object; the build path already cannot tell the
   * difference.
   */
  app.post<{ Params: { id: string }; Body: { refresh?: boolean; review?: boolean } }>(
    "/api/connections/:id/suggestions",
    async (request, reply) => {
      const connection = store.getConnection(request.params.id);
      if (!connection) return reply.status(404).send({ error: "no such connection" });
      registry.addConnection(connection);

      const { value, shapes } = await enumerate(connection, request.body?.refresh === true);

      const suggestions = suggestWidgets({
        connection: connection.id,
        resources: value.resources,
        shapes,
        toneOf: statusTone,
      });

      /*
       * The relationship pass: propose → verify → build → remember.
       *
       * The model reasons over the whole resource graph, including the parts
       * nobody has read, because a pairing like "properties have units" is
       * legible from the nouns long before any request is made. What it cannot
       * know is which field carries the link, so every pairing it proposes is
       * checked against real rows — one request each, paced — and anything
       * unconfirmed is dropped rather than shown.
       *
       * Confirmed links are folded back into the resource graph, so this is
       * paid for once: later widgets and the chat read them off the report.
       *
       * Still entirely optional. No key, a refusal, a malformed answer — all
       * of them leave the rule-authored suggestions exactly as they were.
       */
      let reviewed: ReturnType<typeof mapReviewProposal>[] = [];
      let reviewError: string | null = null;
      let learned: Awaited<ReturnType<typeof verifyPairings>> = [];
      let resources = value.resources;
      const reviewLlm = request.body?.review === false ? null : llmForReview();

      if (reviewLlm) {
        const { proposals, error } = await reviewSuggestions(reviewLlm, {
          connection: connection.id,
          resources,
          shapes,
          existing: suggestions,
        });
        reviewError = error;

        const pairings = proposals.flatMap((proposal) =>
          (proposal.children ?? []).map((child) => ({
            parent: proposal.resource,
            child: child.resource,
            linkField: child.linkField,
          })),
        );

        if (pairings.length > 0) {
          const knownFields = Object.fromEntries(
            Object.entries(shapes).map(([id, shape]) => [id, shape.fields]),
          );
          learned = await verifyPairings(pairings, resources, knownFields, sampleFor(connection));

          // A child read only to check a link is still a resource we now know
          // the fields of — keep it, so the widget can bind real columns.
          for (const pairing of learned) {
            if (pairing.ok && pairing.fields && !shapes[pairing.child]) {
              shapes[pairing.child] = {
                rowsPath: "$",
                rowCount: pairing.fields.length,
                schemaHash: "",
                fields: pairing.fields,
              };
            }
          }
          // The ops go in so a filter parameter is looked up rather than
          // invented — see the note in `applyPairings`.
          resources = applyPairings(resources, learned, connection.ops);
        }

        const confirmed = new Set(
          learned.filter((pairing) => pairing.ok).map((p) => `${p.parent}→${p.child}`),
        );
        const reviewInput = { connection: connection.id, resources, shapes, existing: suggestions };
        reviewed = proposals
          .map((proposal) =>
            mapReviewProposal(
              {
                ...proposal,
                // Only pairings a request stood behind reach the builder.
                children: (proposal.children ?? []).filter((child) =>
                  confirmed.has(`${proposal.resource}→${child.resource}`),
                ),
              },
              reviewInput,
            ),
          )
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        // Remember what was learned, so the next caller pays nothing for it.
        if (learned.some((pairing) => pairing.ok)) {
          store.putReport(
            toReport(connection, { ...value, resources }, shapes, {
              outcome: value.outcome,
              requestsSpent: value.requestsSpent,
            }),
          );
          enumerated.delete(connection.id);
        }
      }

      /*
       * Why there is nothing, when there is nothing.
       *
       * An empty list has several very different causes — the credential was
       * rejected, the API rate-limited us, the account genuinely has no
       * records, or none of its endpoints return collections — and the drawer
       * cannot tell them apart from the list alone. It was left asserting one
       * of them, which reads as the engine being broken when it is working
       * correctly on an API that will not answer.
       */
      const sampled = Object.keys(shapes).length;
      return {
        connection: connection.id,
        suggestions,
        reviewed,
        // Read off the adapter rather than re-derived, so this names the model
        // that actually ran even when the resolution above changes.
        reviewModel: reviewLlm?.defaultModel ?? null,
        reviewError,
        notes: value.notes,
        outcome: value.outcome,
        ...(value.retryAfter ? { retryAfter: value.retryAfter } : {}),
        /** Structure understood vs rows actually seen — the two fail apart. */
        resourceCount: value.resources.length,
        sampledCount: sampled,
        /*
         * What this pass learned about how records relate, and what it tried
         * and could not confirm. Shown so a rejected pairing is visible as a
         * rejected pairing rather than as a missing feature.
         */
        relationships: learned.map((pairing) => ({
          parent: pairing.parent,
          child: pairing.child,
          linkField: pairing.linkField,
          ok: pairing.ok,
          ...(pairing.reason ? { reason: pairing.reason } : {}),
        })),
      };
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
  app.get<{ Params: { id: string } }>(
    "/api/connections/:id/relations",
    async (request, reply) => {
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
    },
  );

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

      const result = await registry.fetch(connection.id, op.id, {}, {
        params: { range: resolveRange({ preset: "30d", now: Date.now() }), filters: {} },
        now: Date.now(),
        resolveSecret: async (keyRef) => keys.get(keyRef),
      });

      const shape = inferShape(result.body, op.rowsPath ? { rowsPath: op.rowsPath } : {});
      const rows = Array.isArray(result.body)
        ? result.body
        : (shape.rowsPath === "$" ? [result.body] : []);

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
    options.settings?.read() ?? { model: null, models: {} };

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
      models: MODELS.map((model) => ({
        ...model,
        // Surfaced so the picker can disable rather than hide — seeing that
        // GPT-4.1 exists but needs a key is more useful than an empty list.
        available: providers[model.provider],
      })),
      selected,
      effective: selected ?? defaultModelId(),
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
    const parsed = z
      .object({
        model: z.string().min(1).max(120).nullable(),
        /** Absent means the global choice; a task name means only that one. */
        task: z.string().max(40).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "a model id (or null to clear) is required" });
    }

    const { model, task } = parsed.data;
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

    return {
      selected: next.model,
      effective: next.model ?? defaultModelId(),
      tasks: TASKS.map((entry) => taskState(entry.id, next)),
    };
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
      catalog,
      llm: (task) => resolveLlm(task),
      // The same SSRF-guarded, allowlist-free entry point discovery uses. A
      // spec is a public document and there is no connection to pin it to.
      fetchDocument: fetchPublicDocument,
    }),
  );

  app.get("/api/catalog", async () => (catalog ? catalog.list() : []));

  app.get<{ Params: { id: string } }>("/api/catalog/:id", async (request, reply) => {
    const entry = catalog?.get(request.params.id);
    if (!entry) return reply.status(404).send({ error: "no such catalog entry" });
    return entry;
  });

  /** Store a locally-derived dialect in the overlay, above the repo seed. */
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/catalog/:id",
    async (request, reply) => {
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
    },
  );

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

    const connection = connectionFromCatalog(entry, {
      id,
      ...(parsed.data.opIds ? { opIds: parsed.data.opIds } : {}),
    });
    store.putConnection(connection);
    ensureBoardFor(connection);
    registry.addConnection(connection);

    const refs = authKeyRefs(connection.auth);
    const ready = refs.length === 0 ? !connection.authRequired : refs.every((ref) => keys.has(ref));
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
    return dashboard;
  });

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
      },
      executeExtraTool: async (name, args) => {
        if (name !== LOOK_UP_TOOL) return { error: `unknown tool "${name}"` };
        const parsed = lookUpSchema.safeParse(args);
        if (!parsed.success) return { error: "look_up_endpoint needs a `query` string" };
        return lookUpEndpoint(conciergeContext(), parsed.data);
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
        const suggestions = reports.flatMap((report) => {
          const connection = store.getConnection(report.connection);
          if (!connection) return [];
          const { value, shapes } = fromReport(report);
          return suggestWidgets({
            connection: report.connection,
            resources: value.resources,
            shapes,
            toneOf: statusTone,
          });
        });

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
          suggestions,
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
                    const context = conciergeContext();
                    const owner = context.ops.find((entry) => entry.id === op)?.connection;
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
                        const result = await registry.fetch(connection.id, opId, {}, {
                          params: {
                            range: resolveRange({ preset: "30d", now: Date.now() }),
                            filters: {},
                          },
                          now: Date.now(),
                          resolveSecret: async (keyRef) => keys.get(keyRef),
                        });
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
             * The two model calls that choose the endpoint and bind the
             * fields. Omitted entirely when there is no model, which is what
             * makes the card fall back to asking rather than to failing.
             */
            ...(options.llm
              ? {
                  propose: async (intent: string) => {
                    const model = resolveLlm("widget");
                    if (!model) return { patch: {}, reason: "", notes: [], ambiguities: [] };
                    return proposeSetup({
                      llm: model,
                      intent,
                      context: conciergeContext(),
                    });
                  },
                }
              : {}),
          },
          allDashboards: store
            .listDashboards()
            .map((board) => ({ id: board.id, title: board.title })),
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
        const headers =
          (request as { headers?: Record<string, unknown> })?.headers ?? {};
        return {
          userId: LOCAL_USER_ID,
          extra: { dashboardId: headers["x-dash-dashboard"] },
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
