import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import {
  ALL_ROWS,
  authCredentials,
  connectionCredentials,
  connectionNeedsAddress,
  connectionSchema,
  parseWidget,
  type AuthCredential,
  type CatalogEntry,
  type ConnectionSpec,
  type WidgetSpec,
} from "@freebirdai/dash-spec";
import { connectionFromCatalog } from "@freebirdai/connect/catalog";
import { AUTO_INDEX_PAGES, discover } from "@freebirdai/connect/discovery/index";
import { integrate } from "@freebirdai/connect/integrate/agent";
import { DependentAdapter, RestAdapter } from "@freebirdai/connect/adapters";
import { getOp, paramsForWidget, resolveRange } from "@freebirdai/dash-spec";
import { OAuthRetryAdapter, RateLimitWaitAdapter } from "@freebirdai/connect/auth/retry-adapter";
import { ConnectorAdapter } from "@freebirdai/connect/connector/adapter";
import {
  withAddedReads,
  withEntryResources,
  withObservedFields,
} from "@freebirdai/connect/integrate/observed";
import { seekRecords } from "@freebirdai/connect/integrate/seek";
import type { SeenSet } from "@freebirdai/connect/integrate/values";
import { integrationTargets, samplingTargets } from "../routes/integrate.js";
import { chooseByBrief, observeFirstRead } from "./brief-choice.js";
import { benchConnectors } from "./connectors.js";
import { benchCredentials, signInAsThePerson } from "./oauth.js";
import type {
  IntegrationEnv,
  IntegrationOutcome,
  Integrator,
  Intervention,
  MockProvider,
  ScenarioInput,
  ScriptedChoice,
} from "./types.js";
import { BrowserDocsRenderer, RendererTooling } from "@freebirdai/connect-browser";

/**
 * The widget a scripted choice describes: one number over one endpoint.
 *
 * Built the way a total is built everywhere else — grouped on the constant
 * `ALL_ROWS` — so the benchmark exercises the same runtime a board does.
 */
/** Playwright's Chromium where it is installed, never fetched: its requests answered by the benchmark's own transport. */
export const benchRenderer = (fetchDocument: IntegrationEnv["fetchDocument"]): BrowserDocsRenderer =>
  new BrowserDocsRenderer({
    tooling: benchTooling,
    fetch: async (url) => ({ ...(await fetchDocument(url)), contentType: null }),
  });

/* A folder of its own, with no agreement in it: the benchmark can draw with a browser already here, and never fetches one. */
export const benchTooling = new RendererTooling({ dir: join(tmpdir(), "dash-bench-tooling"), mode: "ask" });

export const widgetFor = (
  connection: ConnectionSpec,
  opId: string,
  title: string,
  choice: ScriptedChoice,
): WidgetSpec | null => {
  const op = connection.ops.find((one) => one.id === opId);
  const measure = choice.measure;
  const parsed = parseWidget({
    id: "objective",
    title: title.slice(0, 200),
    component: "stat",
    source: { connection: connection.id, op: opId },
    pipeline: [
      { op: "extract", path: op?.rowsPath ?? connection.dialect?.rowsPath ?? "$" },
      ...(measure.where ? [{ op: "filter", where: measure.where }] : []),
      {
        op: "group",
        by: [{ field: ALL_ROWS }],
        agg: { value: measure.agg === "count" ? "count()" : `sum(${measure.field ?? ""})` },
      },
    ],
    roles: { value: "value" },
  });
  return parsed.ok ? parsed.value! : null;
};

/** An op whose path is the scripted one. */
/**
 * The op at a path, as the endpoint's own path or its whole path from the host
 * root: an importer may put `/api` in the base address or in each path, and
 * which it chose is not what a scripted choice is measuring.
 */
const opAt = (connection: ConnectionSpec, path: string): string | null => {
  let base = "";
  try {
    base = new URL(connection.baseUrl ?? "").pathname.replace(/\/$/, "");
  } catch {
    /* An address with a blank in it: its own paths only. */
  }
  const exact = connection.ops.find((op) => op.path === path || `${base}${op.path}` === path);
  if (exact) return exact.id;
  /*
   * A scripted path written against an address that holds more of the path —
   * `/search/jql` under `…/rest/api/3` — names the one endpoint whose path ends
   * with it at a segment, where only one does (seen with the trackwell mock
   * API).
   */
  if (!path.startsWith("/")) return null;
  const ending = connection.ops.filter((op) => `${base}${op.path}`.endsWith(path));
  return ending.length === 1 ? ending[0]!.id : null;
};

/** A model that counts its calls, so a run's cost is reported. */
const countingModel = (llm: LlmAdapter | null): { llm: LlmAdapter | null; calls: () => number } => {
  let calls = 0;
  return {
    llm: llm
      ? {
          ...llm,
          generate: (opts) => {
            calls++;
            return llm.generate(opts);
          },
        }
      : null,
    calls: () => calls,
  };
};

const STOP_WORDS = new Set(["your", "the", "api", "key", "value", "from", "for", "and"]);
const wordsOf = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );

/**
 * Which pasted value goes in which field: the person reads each field's label
 * and pastes the value their settings page shows under the same name. With no
 * labels to go on — or no label that matches — values go in the order asked.
 */
export const pasteInto = (
  slots: readonly AuthCredential[],
  input: Pick<ScenarioInput, "credentials" | "credentialLabels">,
): Map<string, string> => {
  const pasted = new Map<string, string>();
  const unused = input.credentials.map((_value, index) => index);
  for (const slot of slots) {
    if (unused.length === 0) break;
    let chosen = unused[0]!;
    const labels = input.credentialLabels;
    if (labels) {
      const wanted = wordsOf(`${slot.label}`);
      let best = 0;
      for (const index of unused) {
        const offered = wordsOf(labels[index] ?? "");
        const overlap = [...wanted].filter((word) => offered.has(word)).length;
        if (overlap > best) {
          best = overlap;
          chosen = index;
        }
      }
    }
    unused.splice(unused.indexOf(chosen), 1);
    pasted.set(slot.keyRef, input.credentials[chosen]!);
  }
  return pasted;
};

/*
 * Asking for a different number of values than the provider issues is a
 * technical question the person cannot answer from their settings page.
 */
const countAsked = (connection: ConnectionSpec, input: ScenarioInput, interventions: Intervention[]) => {
  const slots = connectionCredentials(connection);
  if (slots.length !== input.credentials.length)
    interventions.push({
      kind: "technical",
      what: `asked for ${slots.length} credential value(s) where the provider issues ${input.credentials.length}`,
    });
};

type Connected =
  | {
      readonly connection: ConnectionSpec;
      readonly entry: CatalogEntry;
      readonly secrets: Readonly<Record<string, string>>;
    }
  | { readonly stop: IntegrationOutcome };

/**
 * Documentation to a connection with credentials in it: discovery, the
 * catalog entry's connection, and the pasted values in the order they are
 * asked for. The same first steps for every integrator measured here.
 */
const connectFromDocs = async (
  input: ScenarioInput,
  env: IntegrationEnv,
  llm: LlmAdapter | null,
  notes: string[],
  interventions: Intervention[],
  modelCalls: () => number,
  /** Count a mismatch in what is asked for later, against the connection as it ends up. */
  countLater = false,
): Promise<Connected> => {
  const stop = (stage: string, why: string, connection: ConnectionSpec | null = null) => ({
    stop: {
      connection,
      widget: null,
      secrets: {},
      interventions,
      notes: [...notes, why],
      stoppedAt: stage,
      modelCalls: modelCalls(),
    } satisfies IntegrationOutcome,
  });
  /* As the product discovers: a small documentation section is read by itself when nothing else answered. */
  const found = await discover(input.docsUrl, {
    fetchDocument: env.fetchDocument,
    llm,
    search: null,
    readIndexUpTo: AUTO_INDEX_PAGES,
    /* Documentation drawn by scripts is drawn, where Chromium is installed; the benchmark never downloads it. */
    renderDocs: benchRenderer(env.fetchDocument),
  });
  notes.push(found.note, ...found.warnings);
  if (!found.entry) return stop("discover", "Discovery found nothing to connect to.");

  let connection = connectionFromCatalog(found.entry, { id: input.provider });
  if (connectionNeedsAddress(connection)) {
    /* The person's own account address is theirs to give: asked, and counted, as the product asks. */
    interventions.push({ kind: "account", what: "which account the address is for" });
    if (!input.accountAddress) return stop("address", "The connection needs its account address.", connection);
    const { server: _server, addressPending: _pending, ...rest } = connection;
    connection = connectionSchema.parse({ ...rest, baseUrl: input.accountAddress.replace(/\/+$/, "") });
    notes.push(`Asked which address the account is at: ${connection.baseUrl}.`);
  }

  if (!countLater) countAsked(connection, input, interventions);
  const secrets = Object.fromEntries(pasteInto(connectionCredentials(connection), input));
  return { connection, entry: found.entry, secrets };
};

/**
 * Today's pipeline with nothing added: discovery, a connection from its
 * catalog entry, credentials in the order they are asked for — and then
 * whatever the connection does. No probe, no repair.
 *
 * Its choice of endpoint and measure comes from the scenario's `scripted`
 * field, which a scripted run supplies. That makes it a measure of the part
 * of the pipeline that involves no judgment, and never of anybody's judgment
 * — see PROTOCOL.md.
 */
export const baselineIntegrator = (options: { llm?: LlmAdapter | null } = {}): Integrator => ({
  id: "baseline",
  async integrate(input: ScenarioInput, env): Promise<IntegrationOutcome> {
    const notes: string[] = [];
    const interventions: Intervention[] = [];
    const model = countingModel(options.llm ?? env.llm);
    const connected = await connectFromDocs(input, env, model.llm, notes, interventions, model.calls);
    if ("stop" in connected) return connected.stop;
    const { connection, secrets } = connected;
    const broker = benchCredentials(env, secrets, () => connection);
    const stop = (stage: string, why: string): IntegrationOutcome => ({
      connection,
      widget: null,
      secrets,
      interventions,
      notes: [...notes, why],
      stoppedAt: stage,
      modelCalls: model.calls(),
      broker,
    });
    const signedIn = await signInIfAsked(connection, broker, env, interventions);
    if (signedIn) return stop("sign-in", signedIn);

    const choice = input.objective.scripted;
    if (!choice) return stop("choose", "The baseline has no way to choose an endpoint unscripted.");
    const opId = opAt(connection, choice.path);
    if (!opId) return stop("choose", `No endpoint at ${choice.path} was imported.`);
    const widget = widgetFor(connection, opId, input.objective.request, choice);
    if (!widget) return stop("build", "The widget for this objective did not validate.");
    return { connection, widget, secrets, interventions, notes, modelCalls: model.calls(), broker };
  },
});

/**
 * The person signs in with the provider, when the connection is one they must
 * sign in to. Counted as consent. Returns why it failed, or null.
 */
const signInIfAsked = async (
  connection: ConnectionSpec,
  broker: ReturnType<typeof benchCredentials>,
  env: IntegrationEnv,
  interventions: Intervention[],
): Promise<string | null> => {
  const auth = connection.auth;
  if (auth.type !== "oauth2" || auth.flow !== "authorization_code") return null;
  interventions.push({ kind: "consent", what: "signed in with the provider" });
  const result = await signInAsThePerson(connection, broker, env);
  return result.ok ? null : `Signing in did not finish: ${result.why}`;
};

/**
 * The integration loop: the baseline's first steps, then
 * `integrate` over the endpoint the objective reads — repairs, the paging
 * probe and evidence — before the widget is built.
 *
 * Its choice of endpoint still comes from the scenario's `scripted` field;
 * what it is measured on is getting that endpoint to read completely and
 * correctly with nobody editing anything.
 */
export const agentIntegrator = (options: { llm?: LlmAdapter | null; requests?: number } = {}): Integrator => ({
  id: "agent",
  async integrate(input: ScenarioInput, env): Promise<IntegrationOutcome> {
    const notes: string[] = [];
    const interventions: Intervention[] = [];
    const model = countingModel(options.llm ?? env.llm);
    const connected = await connectFromDocs(input, env, model.llm, notes, interventions, model.calls, true);
    if ("stop" in connected) {
      if (connected.stop.connection) countAsked(connected.stop.connection, input, interventions);
      return connected.stop;
    }
    const { entry } = connected;
    let connection = connected.connection;
    /* The scenario's vault: what the person pasted, and what they paste once asked for more. */
    const vault = new Map(Object.entries(connected.secrets));
    const broker = benchCredentials(env, vault, () => connection);
    const connectors = benchConnectors(env.now);
    const secretsNow = () => Object.fromEntries(vault);
    const stop = (stage: string, why: string): IntegrationOutcome => ({
      connection,
      widget: null,
      secrets: secretsNow(),
      interventions,
      notes: [...notes, why],
      stoppedAt: stage,
      modelCalls: model.calls(),
      broker,
    });
    const signedIn = await signInIfAsked(connection, broker, env, interventions);
    if (signedIn) return stop("sign-in", signedIn);

    /*
     * What answers the objective: the scenario's scripted choice where there is
     * one, and otherwise the product's own path — record types, a brief, a
     * compiled widget — with the endpoint that widget reads settled next.
     */
    const choice = input.objective.scripted;
    let targets: string[];
    let chosen: WidgetSpec | null = null;
    let compiledFrom: { brief: import("@freebirdai/dash-spec").WidgetBrief; entity: import("@freebirdai/dash-spec").EntitySpec } | null = null;
    /** What the integration loop runs with: this scenario's credentials and connector kit. */
    const checkDeps = {
      http: env.http,
      resolveSecret: broker.resolve,
      refresh: broker.refresh,
      fetchDocument: env.fetchDocument,
      now: () => env.now,
      llm: model.llm,
      connectors,
      /* A short rate limit is waited out, as the product's check does. */
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    /** The integration loop over some endpoints. */
    const settleOps = (ops: readonly string[], requests: number, sample: readonly string[] = []) =>
      integrate(
        connection,
        /* With the request: an input another list supplies is settled to the record it names, else read for every one. */
        { targets: ops, entry, docsUrl: input.docsUrl, requests, traverseUpTo: 50, sample, objective: input.objective.request },
        checkDeps,
      );
    if (choice) {
      let opId = opAt(connection, choice.path);
      /*
       * Not imported: looked for as the product would, from the request's own
       * words among the endpoints the documentation names — never from the
       * scripted path, which a person never gives.
       */
      if (!opId) {
        const sought = await seekRecords({ connection, entry, request: input.objective.request, docsUrl: input.docsUrl, deps: checkDeps });
        if (sought) notes.push(...sought.log);
        if (sought && sought.added.length > 0) {
          connection = sought.connection;
          opId = opAt(connection, choice.path);
        }
      }
      if (!opId) return stop("choose", `No endpoint at ${choice.path} was imported.`);
      targets = [opId];
    } else {
      if (!model.llm) return stop("choose", "Choosing without a script needs a model.");
      /*
       * The product's own check first: what runs by itself once a key is saved
       * (or at once, for an API that needs none), before anybody asks for
       * anything. Its reads are what an endpoint with no declared fields is
       * described from — the same order the product runs in.
       */
      let described = entry;
      let seen: Readonly<Record<string, SeenSet>> = {};
      const own = integrationTargets(connection, { canWriteCode: true });
      if (own.length > 0) {
        /* And a first page of the other collections nothing declared fields for, as the product's check reads them. */
        const sample = samplingTargets(connection, entry, own);
        let precheck = await settleOps(own, 60, sample);
        notes.push(...precheck.changes.map((change) => `Changed by the first check: ${change}`), ...precheck.log);
        connection = precheck.connection;
        if (precheck.needsCredentials) {
          for (const [keyRef, value] of pasteInto(precheck.needsCredentials, input)) vault.set(keyRef, value);
          precheck = await settleOps(own, 60, sample);
          notes.push(...precheck.log);
          connection = precheck.connection;
        }
        /* Reads written from a GraphQL schema the API answered with, then what the reads showed. */
        const read = withAddedReads(entry, precheck.added) ?? entry;
        described = withObservedFields(read, precheck.observed) ?? read;
        seen = precheck.values;
        connection = withEntryResources(connection, described);
        if (described !== entry)
          notes.push(`The first check read fields the documentation did not declare, for ${Object.keys(precheck.observed).join(", ")}.`);
      }
      const writeBriefOver = (over: CatalogEntry) =>
        chooseByBrief({
          connection,
          entry: over,
          request: input.objective.request,
          llm: model.llm!,
          today: new Date(env.now).toISOString().slice(0, 10),
          seen,
        });
      let brief = await writeBriefOver(described);
      notes.push(...brief.notes);
      /*
       * No record type is what the request is about, or none could be
       * described: the documentation is read again for the endpoints it names
       * that the import missed, each checked, and the brief written once more
       * — as the product does.
       */
      if ("stop" in brief && (brief.stop === "describe" || brief.stop === "choose")) {
        const sought = await seekRecords({
          connection,
          entry: described,
          request: input.objective.request,
          docsUrl: input.docsUrl,
          deps: checkDeps,
        });
        if (sought) notes.push(...sought.log);
        if (sought && sought.added.length > 0) {
          connection = withEntryResources(sought.connection, sought.entry);
          described = sought.entry;
          seen = { ...seen, ...sought.report.values };
          brief = await writeBriefOver(described);
          notes.push(...brief.notes);
        }
      }
      if ("stop" in brief) return stop(brief.stop, brief.why);
      chosen = brief.widget;
      compiledFrom = { brief: brief.brief, entity: brief.entity };
      targets = [...brief.ops];
    }

    const check = () => settleOps(targets, options.requests ?? 80);
    let report = await check();
    notes.push(...report.changes.map((change) => `Changed: ${change}`), ...report.log);
    connection = report.connection;
    /*
     * Connector code declared a sign-in the connection did not have: the
     * person is asked for those values, in the documentation's words, and the
     * check runs again by itself — as it does in the product once they paste.
     */
    if (report.needsCredentials) {
      for (const [keyRef, value] of pasteInto(report.needsCredentials, input)) vault.set(keyRef, value);
      report = await check();
      notes.push(...report.changes.map((change) => `Changed: ${change}`), ...report.log);
      connection = report.connection;
    }
    countAsked(connection, input, interventions);
    if (report.outcome === "blocked") return stop("integrate", report.blocked ?? "The connection could not be read.");

    /* The product's first read, observed: a widget compiled from a brief is rebuilt if the records are not where the docs said. */
    if (chosen && compiledFrom && targets[0]) {
      try {
        const rest = connection.connector
          ? new ConnectorAdapter(env.http, connectors)
          : new RateLimitWaitAdapter(new RestAdapter(env.http));
        const adapter = new DependentAdapter(new OAuthRetryAdapter(rest, broker));
        const op = getOp(connection, targets[0]);
        if (op) {
          const read = await adapter.fetch(connection, op, {}, {
            params: paramsForWidget(chosen, { range: resolveRange({ preset: "30d", now: env.now }), filters: {} }, env.now),
            now: env.now,
            resolveSecret: broker.resolve,
          });
          const rebuilt = observeFirstRead({
            connection,
            brief: compiledFrom.brief,
            entity: compiledFrom.entity,
            opId: targets[0],
            body: read.body,
            at: new Date(env.now).toISOString(),
          });
          if (rebuilt) {
            chosen = rebuilt.widget;
            notes.push(...rebuilt.notes);
          }
        }
      } catch (error) {
        notes.push(`The first read could not be observed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const widget = chosen ?? (choice ? widgetFor(connection, targets[0]!, input.objective.request, choice) : null);
    if (!widget) return stop("build", "The widget for this objective did not validate.");
    return { connection, widget, secrets: secretsNow(), interventions, notes, modelCalls: model.calls(), broker };
  },
});

/**
 * A provider's hand-written connection, for proving its answer keys.
 *
 * Not an integrator anybody is measuring: it knows the answer to every
 * question the others have to work out. If the reference plus a scripted
 * choice misses an answer, the key is wrong — which is the one thing the
 * benchmark must never be.
 */
export const referenceIntegrator = (provider: MockProvider): Integrator => ({
  id: "reference",
  async integrate(input, env) {
    const reference = provider.reference;
    const choice = input.objective.scripted;
    const parsed = reference ? connectionSchema.safeParse(reference.connection) : null;
    if (!reference || !choice || !parsed?.success) {
      return {
        connection: null,
        widget: null,
        secrets: {},
        interventions: [],
        notes: [parsed && !parsed.success ? parsed.error.message : "no reference connection"],
        stoppedAt: "reference",
        modelCalls: 0,
      };
    }
    const connection = parsed.data;
    const opId = opAt(connection, choice.path);
    const broker = benchCredentials(env, reference.secrets, () => connection);
    const interventions: Intervention[] = [];
    const signedIn = await signInIfAsked(connection, broker, env, interventions);
    return {
      connection,
      widget: opId && !signedIn ? widgetFor(connection, opId, input.objective.request, choice) : null,
      secrets: reference.secrets,
      interventions,
      notes: signedIn ? [signedIn] : [],
      modelCalls: 0,
      broker,
      ...(signedIn ? { stoppedAt: "sign-in" } : {}),
    };
  },
});
