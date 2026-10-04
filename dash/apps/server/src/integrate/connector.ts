import { HOOKS, proposeConnector, type ConnectorProposal, type LlmAdapter } from "@freebirdai/dash-agent";
import {
  CONNECTOR_CONTRACT,
  MAX_PAGES,
  OPERATION_HOOKS,
  authCredentials,
  connectorRequestSchema,
  authKeyRefs,
  connectionKeyRef,
  getOp,
  pathParamNames,
  requestMatches,
  type AuthSpec,
  type ConnectionSpec,
  type ConnectorAuthority,
  type ConnectorRequest,
  type ConnectorSpec,
} from "@freebirdai/dash-spec";
import { ConnectorAdapter, connectorHash } from "../connector/adapter.js";
import type { ConnectorRequestEvent, ConnectorTokenStore, KnownWrite } from "../connector/host.js";
import type { ConnectorSandbox } from "../connector/sandbox.js";
import type { DocsKnowledge } from "./docs.js";
import { applyPatch, patchProblem, sameSite, type ConnectionPatch } from "./patch.js";
import { tryRead, type Attempt, type ReadDeps } from "./read.js";
import { describeTemplate, isProving, mergeAuthority, provingTemplates, templatesFromTrace, templatesProblem, uniqueTemplates } from "./templates.js";

/**
 * Connector code, written and proven by the integration loop.
 *
 * Reached when no repair in the connection's own vocabulary can work. A model
 * reads the documentation and writes the code and the authority it needs; the
 * code is loaded in the sandbox, installed on a copy of the connection, and
 * read through — the same adapter a board uses, against the real API. It is
 * kept only when that read returns records. When it does not, the model is
 * shown what happened (the error, the requests the code sent, what it logged —
 * never a credential) and tries again, a bounded number of times.
 *
 * A connector that declares credentials nobody has pasted yet cannot be tried.
 * It is kept as a draft, and the check reports the values it is waiting for:
 * the person is asked for them in the documentation's own words, and the next
 * check tries the code.
 *
 * Acceptance is the read, and in the benchmark the answer key — never tests
 * the model writes about its own code.
 */

/**
 * A read through connector code that came back, but not whole: the code said
 * it stopped early, or fell short of its own total. Records came back, so it
 * looks like success — and a loop that took it for one kept code that read
 * 50 of 230 records.
 */
export const stoppedShort = (connection: ConnectionSpec, opId: string, attempt: Attempt): boolean =>
  attempt.kind === "ok" && attempt.meta?.truncated === true && getOp(connection, opId)?.servedBy === "connector";

/** What to tell the model about a read that stopped short. */
const shortFeedback = (attempt: Attempt): string =>
  [
    `It read ${attempt.rows?.length ?? 0} record(s) and then stopped before the end of them.`,
    ...(attempt.meta?.warnings ?? []).map((warning) => `The read said: ${warning}`),
    `A dashboard total over part of the records is wrong. Read every record the endpoint holds: ctx.maxPages (${MAX_PAGES}) is the most pages to read in one run, not a size to stop at. Where that takes more than one run's allowance of about 100 requests, return what was read with resume set to where you got to, and carry on from ctx.resume in the next run; never return done: "partial" for want of allowance.`,
  ].join(" ");

/**
 * A read through connector code that returned records and never said whether
 * they were all of them. Kept if it must be — the records are real — but it
 * claims nothing, so the code is asked once to say how its read ended.
 */
export const endUnsaid = (connection: ConnectionSpec, opId: string, attempt: Attempt): boolean =>
  attempt.kind === "ok" && attempt.meta?.completion?.state === "unknown" && getOp(connection, opId)?.servedBy === "connector";

const unsaidFeedback = (attempt: Attempt): string =>
  `It read ${attempt.rows?.length ?? 0} record(s) and did not say whether that was every record: return done: "all" on the run that reaches the end, but only when the API showed there was nothing more (an empty or short last page, no next cursor, has_more false, every part read). Without it the read is shown as possibly incomplete, and no total is trusted.`;

/** What running connector code needs. The server's; the benchmark's own in a run. */
export interface ConnectorKit {
  readonly sandbox: ConnectorSandbox;
  readonly tokens: ConnectorTokenStore;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly seed?: () => number;
  /** The catalog's endpoints that change the account: refused to connector code on any grant. */
  readonly writes?: (connection: ConnectionSpec) => readonly KnownWrite[];
}

/** What a run sent, kept: for the next attempt's model, and for learning the requests the code really sends. */
export interface SeenRequests {
  readonly requests: string[];
  readonly log: string[];
  /** Every request, by the endpoint it was sent for. */
  readonly events?: Array<{ readonly op: string; readonly event: ConnectorRequestEvent }>;
}

/** A read through the connector adapter, with its requests and log lines kept for the next attempt. */
export const connectorReader = (kit: ConnectorKit, seen?: SeenRequests): NonNullable<ReadDeps["adapter"]> => (http) =>
  new ConnectorAdapter(http, {
    sandbox: kit.sandbox,
    tokens: kit.tokens,
    ...(kit.now ? { now: kit.now } : {}),
    ...(kit.sleep ? { sleep: kit.sleep } : {}),
    ...(kit.seed ? { seed: kit.seed } : {}),
    ...(kit.writes ? { writes: kit.writes } : {}),
    ...(seen
      ? {
          onRequest: (_connection, op, event: ConnectorRequestEvent) => {
            if (seen.events && seen.events.length < 400) seen.events.push({ op: op.id, event });
            if (seen.requests.length < 60)
              seen.requests.push(
                `${event.method} ${event.host}${event.path} → ${event.refused ? `refused: ${event.refused}` : (event.status ?? "no answer")}`,
              );
          },
          onLog: (_connection, line) => {
            if (seen.log.length < 60) seen.log.push(line);
          },
        }
      : {}),
  });

export interface AuthoringInput {
  readonly connection: ConnectionSpec;
  readonly opId: string;
  /** Why the endpoint cannot be read as configured. */
  readonly problem: string;
  readonly docs: DocsKnowledge;
  readonly docsUrl?: string | undefined;
  readonly llm: LlmAdapter;
  readonly kit: ConnectorKit;
  readonly read: ReadDeps;
  readonly attempts: number;
  /** The catalog's endpoints that change the account: no template may be one. */
  readonly writes?: readonly KnownWrite[] | undefined;
  readonly now: () => number;
}

export interface Authored {
  /** The connection with the connector installed — proven, or a draft waiting for credentials. */
  readonly connection: ConnectionSpec | null;
  readonly patch?: ConnectionPatch;
  readonly because?: string;
  readonly attempt: Attempt | null;
  readonly log: readonly string[];
  readonly modelCalls: number;
  readonly cannot?: string;
}

/** The endpoint, for the model: what the documentation says it is. */
const describeEndpoint = (connection: ConnectionSpec, opId: string): string => {
  const op = getOp(connection, opId);
  if (!op) return opId;
  return [
    `${op.method} ${op.path} — ${op.title}${op.description ? `: ${op.description}` : ""}`,
    `Id: ${op.id}`,
    op.params.length > 0
      ? `Parameters: ${op.params.map((param) => `${param.name} (${param.in}${param.required ? ", required" : ""})`).join(", ")}`
      : "Parameters: none",
    `What a board needs from it: every record it holds, as a list.`,
    /*
     * A board has nothing to give an id in the path. Told only "id (path,
     * required)", a model wrote code waiting for an export id somebody else
     * would supply, and read nothing (measurement 1).
     */
    ...(pathParamNames(op.path).length > 0
      ? [
          `Nobody will supply ${pathParamNames(op.path)
            .map((name) => `"${name}"`)
            .join(" or ")}: it is not in ctx.inputs, and ctx.request lists it as missing. The code must obtain it from the API itself, as the documentation describes — by listing, searching or starting what it names — and read everything there is.`,
        ]
      : []),
  ].join("\n");
};

const hostOf = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** Why a proposal may not be installed, or null. The authority is checked here as well as at every request. */
const authorityProblem = (connection: ConnectionSpec, proposal: ConnectorProposal, docsUrl: string | undefined): string | null => {
  const own = [hostOf(connection.baseUrl), hostOf(docsUrl)].filter((one): one is string => !!one);
  for (const destination of proposal.destinations) {
    const host = destination.host.toLowerCase();
    if (destination.role === "api" && !own.some((one) => sameSite(one, host)))
      return `${host} is not part of the service being connected (${own.join(", ")}), so it cannot receive requests with credentials. A separate file host is a download.`;
  }
  if (!proposal.destinations.some((one) => one.role === "api"))
    return "no destination is the service itself.";
  return null;
};

/**
 * The connector's sign-in: each value the person pastes under the name the
 * code uses, with a vault name of its own.
 *
 * Where the connection already asks for the same number of values, their vault
 * names are kept in order, so a key that was pasted is not asked for again.
 */
const connectorAuth = (connection: ConnectionSpec, proposal: ConnectorProposal): Extract<AuthSpec, { type: "connector" }> => {
  const previous = connection.auth;
  const oldRefs = authKeyRefs(previous);
  const oldByName = new Map(
    previous.type === "connector" ? previous.credentials.map((one) => [one.name, one.keyRef] as const) : [],
  );
  const count = proposal.credentials.length;
  const credentials = proposal.credentials.map((credential, index) => ({
    name: credential.name,
    keyRef:
      oldByName.get(credential.name) ??
      (oldRefs.length === count ? oldRefs[index]! : count === 1 ? connectionKeyRef(connection.id) : connectionKeyRef(connection.id, index + 1)),
    label: credential.label.slice(0, 80),
    ...(credential.hint ? { hint: credential.hint.slice(0, 200) } : {}),
    ...(credential.secret === false ? { secret: false } : {}),
  }));
  const stem = (credentials[0]?.keyRef ?? connectionKeyRef(connection.id)).slice(0, 40);
  return {
    type: "connector",
    credentials,
    tokens: (proposal.exchanges ?? []).map((exchange) => ({ name: exchange.name, keyRef: `${stem}-${exchange.name}`.slice(0, 64) })),
  };
};

/** Load the code once to learn which hooks it defines — and whether it loads at all. With a module, beside the shared code. */
const hooksOf = async (kit: ConnectorKit, code: string, module?: string): Promise<ConnectorSpec["hooks"] | string> => {
  try {
    const session = await kit.sandbox.open({
      code,
      ...(module !== undefined ? { module } : {}),
      host: {
        call: async () => {
          throw new Error("nothing is allowed while loading");
        },
        now: kit.now ?? Date.now,
        log: () => undefined,
      },
      limits: { wallMs: 10_000 },
    });
    const hooks = [...session.hooks];
    await session.close();
    return hooks.length > 0 ? hooks : "the code defines none of the hooks";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * The requests a proposal declares, as templates on the hosts it names —
 * written the way the schema reads them: a path without its query string, a
 * download carrying nothing. One the schema still refuses is named, with why,
 * for the model to fix, rather than failing the whole connection unexplained.
 */
const declaredTemplates = (
  proposal: ConnectorProposal,
  downloads: ReadonlySet<string>,
): { readonly templates: ConnectorRequest[]; readonly invalid: string | null } => {
  const templates: ConnectorRequest[] = [];
  for (const request of proposal.requests ?? []) {
    let path = request.path.trim();
    try {
      /* A whole address, or a path with a query: the path alone. */
      path = /^https?:\/\//i.test(path) ? new URL(path).pathname : path.split(/[?#]/)[0]!;
    } catch {
      /* Left for the schema to name. */
    }
    if (!path.startsWith("/")) path = `/${path}`;
    const host = request.host.toLowerCase();
    const download = request.purpose === "download" || downloads.has(host);
    const candidate = {
      id: request.id.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^[^a-z]+/, "").slice(0, 40) || `request_${templates.length + 1}`,
      purpose: download ? "download" : request.purpose,
      method: request.method,
      host,
      path,
      credentials: download ? [] : [...new Set(request.credentials)],
      /*
       * A POST's body as declared: its fields checked only where it has fields
       * — JSON or form. An XML document declared with "keys" was once held to
       * JSON, and every request its code sent was refused.
       */
      ...(request.method === "POST" && (request.bodyType || request.bodyKeys)
        ? {
            body: {
              type: request.bodyType ?? ("json" as const),
              ...((request.bodyType ?? "json") === "json" || request.bodyType === "form" ? (request.bodyKeys ? { keys: request.bodyKeys } : {}) : {}),
            },
          }
        : {}),
    };
    const parsed = connectorRequestSchema.safeParse(candidate);
    if (!parsed.success)
      return {
        templates,
        invalid: `the request "${request.id}" (${request.method} ${request.host}${request.path}) is not one a connector can declare: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    templates.push(parsed.data);
  }
  return { templates: uniqueTemplates(templates), invalid: null };
};

/**
 * The templates a proven connector keeps: everything declared, and for each
 * request it sent while being proven that nothing declared covers, the
 * request itself — never the GET-anywhere allowance proving needed.
 */
const provenTemplates = (
  authority: ConnectorAuthority,
  events: readonly ConnectorRequestEvent[],
): ConnectorRequest[] | undefined => {
  if (!authority.templates) return undefined;
  const kept = authority.templates.filter((one) => !isProving(one));
  const unmatched = events.filter(
    (event) => !event.refused && event.status !== null && !kept.some((one) => requestMatches(one, event.method, event.host, event.path)),
  );
  return [...kept, ...templatesFromTrace(unmatched, authority.destinations, new Set(kept.map((one) => one.id)))];
};

/** An endpoint's own module defines how it reads, nothing else. */
const moduleHooksOf = (code: string): ConnectorSpec["operations"][string]["hooks"] =>
  OPERATION_HOOKS.filter((hook) => new RegExp(`\\bfunction\\s+${hook}\\b|\\b${hook}\\s*=`).test(code));

/**
 * Connector code for one endpoint, written and proven.
 *
 * Two ways, by what is already there:
 * - **Beside** shared code that already reads other endpoints, or signs: the
 *   model writes this endpoint's own module, and nothing that reads already is
 *   touched. Writing code for a second endpoint once replaced the code that
 *   read the first.
 * - **Whole**: no connector yet, or the sign-in itself must change. A
 *   replacement of shared code other endpoints read through is installed only
 *   once every one of them reads again with it, all at once, its version one
 *   higher and the code it replaced kept for a rollback.
 *
 * Every POST the code sends is declared, and checked before the code runs:
 * named by the documentation, and never an endpoint that changes the account.
 * While code is proven a GET on the service's own hosts is allowed; what it
 * then sent becomes its templates, and after that nothing undeclared leaves.
 */
export const authorConnector = async (input: AuthoringInput): Promise<Authored> => {
  const log: string[] = [];
  let modelCalls = 0;
  let previous: { code: string; failure: string; requests: string[]; log: string[] } | undefined;
  let last: Attempt | null = null;
  /* Code that read records but never said they were all: asked once, and kept if the revision does no better. */
  let unsaidAsked = false;
  let kept: { connection: ConnectionSpec; patch: ConnectionPatch; because: string; attempt: Attempt } | null = null;
  /* The prose, and the reference beside it: code needs every endpoint's inputs and answers, not only the overview. */
  const outline = await input.docs.outline();
  const fullText = await input.docs.text();
  const docsText = [fullText.slice(0, 6_000), outline ? `THE SPECIFICATION, ENDPOINT BY ENDPOINT:\n${outline}` : ""]
    .filter((one) => one !== "")
    .join("\n\n");
  /* What a POST is checked against: every word of the documentation, not only what the model is shown. */
  const ground = [fullText, outline ?? ""].join("\n");
  const op = getOp(input.connection, input.opId);
  if (!op) return { connection: null, attempt: null, log, modelCalls };
  const existing = input.connection.auth.type === "connector" ? input.connection.connector : undefined;
  /* The endpoints the connector reads already, besides this one: what a replacement must go on reading. */
  const others = existing
    ? [...new Set([...existing.serves, ...Object.keys(existing.operations)])].filter(
        (id) => id !== input.opId && getOp(input.connection, id) !== undefined,
      )
    : [];
  /* Shared code this endpoint's own module can be written beside: it reads others or signs, and is not this endpoint's own read. */
  const beside =
    existing &&
    !existing.serves.includes(input.opId) &&
    (others.length > 0 || existing.hooks.includes("authenticate") || existing.hooks.includes("signRequest"))
      ? existing
      : undefined;
  const ownModule = existing?.operations[input.opId];
  if (beside && ownModule) previous = { code: ownModule.code, failure: input.problem, requests: [], log: [] };
  else if (existing) previous = { code: existing.code, failure: input.problem, requests: [], log: [] };

  for (let round = 0; round < input.attempts; round++) {
    modelCalls++;
    const answer = await proposeConnector(input.llm, {
      apiTitle: input.connection.title,
      baseUrl: input.connection.baseUrl ?? "",
      endpoint: describeEndpoint(input.connection, input.opId),
      problem: input.problem,
      docs: docsText,
      contract: CONNECTOR_CONTRACT,
      ...(input.connection.auth.type === "connector"
        ? { credentials: input.connection.auth.credentials.map((one) => ({ name: one.name, label: one.label ?? one.name })) }
        : {}),
      ...(beside
        ? {
            shared: {
              code: beside.code,
              reads: others.map((id) => getOp(input.connection, id)?.title ?? id),
              requests: (beside.authority.templates ?? []).filter((one) => !isProving(one)).map(describeTemplate),
            },
          }
        : {}),
      ...(previous ? { previous } : {}),
    });
    if ("error" in answer) {
      log.push(`Asked a model for connector code; ${answer.error}`);
      break;
    }
    const proposal = answer.proposal;
    /*
     * "Cannot" with code beside it is a caveat, not a refusal: the code is
     * tried like any other, and the note kept as an assumption. It once
     * stopped a check before code that came with one had run at all.
     */
    const caveat = [proposal.assumptions, proposal.cannot && HOOKS.test(proposal.code) ? proposal.cannot : undefined]
      .filter((one): one is string => !!one)
      .join(" ");
    if (caveat) log.push(`The model wrote connector code assuming: ${caveat.slice(0, 600)}`);
    if (proposal.cannot && !HOOKS.test(proposal.code)) {
      log.push(`A model read the documentation and could not write connector code: ${proposal.cannot}`);
      return { connection: null, attempt: last, log, modelCalls, cannot: proposal.cannot };
    }

    const part: "endpoint" | "whole" = beside && proposal.part !== "whole" ? "endpoint" : "whole";
    const downloadHosts = new Set(proposal.destinations.filter((one) => one.role === "download").map((one) => one.host.toLowerCase()));
    const { templates: declared, invalid } = declaredTemplates(proposal, downloadHosts);
    const refused =
      authorityProblem(input.connection, proposal, input.docsUrl) ??
      invalid ??
      templatesProblem(declared, { docs: ground, writes: input.writes ?? [], connection: input.connection }) ??
      (part === "endpoint" && moduleHooksOf(proposal.code).length === 0
        ? "an endpoint's own code defines read, or parse and paginate"
        : null);
    const hooks = refused
      ? refused
      : part === "endpoint"
        ? await hooksOf(input.kit, beside!.code, proposal.code)
        : await hooksOf(input.kit, proposal.code);
    if (typeof hooks === "string") {
      log.push(`Connector code was not tried: ${hooks}`);
      previous = { code: proposal.code, failure: `It was not run: ${hooks}`, requests: [], log: [] };
      continue;
    }

    const author = { by: "model" as const, model: input.llm.defaultModel.slice(0, 80), at: new Date(input.now()).toISOString() };
    const destinations = proposal.destinations.map((one) => ({
      host: one.host.toLowerCase(),
      role: one.role,
      methods: [...new Set(one.methods)],
      credentials: one.role === "download" ? [] : [...new Set(one.credentials)],
    }));
    /*
     * What the code may send while it is proven: what it declared, and a GET
     * anywhere on its hosts — narrowed, once it reads, to what it sent. Where
     * the connector predates templates it keeps its hosts and methods for now:
     * the check declares the requests it really sends once every endpoint it
     * reads has read.
     */
    /*
     * Proven as connectors were before templates — hosts and methods its limit,
     * the catalog's changes still refused — where nothing declares any:
     * a connector from before templates (the check declares its requests once
     * every endpoint it reads has read), or code that listed none, whose
     * requests are learned from what it sent and checked like declared ones.
     */
    /* A whole rewrite of pre-template code that declares its requests takes templates from then on, every endpoint it reads proven below. */
    const legacy =
      part === "endpoint"
        ? beside!.authority.templates === undefined
        : declared.length === 0 && (existing === undefined || existing.authority.templates === undefined);
    const proposed: ConnectorAuthority = {
      destinations,
      exchanges: (proposal.exchanges ?? []).map((one) => ({ name: one.name, fields: one.fields ?? [] })),
      ...(legacy ? {} : { templates: [...declared, ...provingTemplates(destinations)] }),
      retries: 1,
      requests: 100,
      sleepMs: 30_000,
      wallMs: 60_000,
    };
    const auth = part === "endpoint" ? input.connection.auth : connectorAuth(input.connection, proposal);
    const serves = part === "endpoint" || proposal.serves || hooks.includes("read");
    const posts =
      declared.some((one) => one.method === "POST") ||
      proposal.destinations.some((one) => one.role === "api" && one.methods.includes("POST"));
    const connector: ConnectorSpec =
      part === "endpoint"
        ? {
            ...beside!,
            serves: [...new Set([...beside!.serves.filter((id) => id !== input.opId)])],
            operations: {
              ...beside!.operations,
              [input.opId]: {
                code: proposal.code,
                hash: connectorHash(proposal.code),
                hooks: moduleHooksOf(proposal.code),
                templates: declared.map((one) => one.id),
                summary: proposal.summary.slice(0, 600),
                author,
              },
            },
            authority: mergeAuthority(
              legacy ? beside!.authority : { ...beside!.authority, templates: [...(beside!.authority.templates ?? []), ...provingTemplates(beside!.authority.destinations)] },
              proposed,
            ),
          }
        : {
            code: proposal.code,
            hash: connectorHash(proposal.code),
            hooks,
            /* The endpoints the old shared code read must still be read by the new: they are proven below. */
            serves: [...new Set([...(existing?.serves.filter((id) => id !== input.opId) ?? []), ...(serves ? [input.opId] : [])])],
            operations: Object.fromEntries(Object.entries(existing?.operations ?? {}).filter(([id]) => id !== input.opId)),
            authority: existing ? mergeAuthority(existing.authority, proposed) : proposed,
            version: existing ? existing.version + 1 : 1,
            ...(existing ? { previous: { code: existing.code, hash: existing.hash, hooks: existing.hooks, version: existing.version } } : {}),
            summary: proposal.summary.slice(0, 600),
            author,
          };
    /*
     * Without templates the limit is a host and a method, and what was sent
     * is checked only after it was: a POST to an endpoint the catalog never
     * listed as a write would leave before anything could refuse it, and its
     * body — a GraphQL mutation, say — is checked against nothing. Such code
     * is tried with GET alone; code that POSTs declares each request first.
     */
    if (!connector.authority.templates && connector.authority.destinations.some((one) => one.methods.includes("POST"))) {
      const why =
        part === "endpoint"
          ? "it may send POST, and the shared code it is written beside declares none of its requests; POST is allowed only to requests declared in \"requests\", so rewrite the whole connector and list every request it sends"
          : "it may send POST and declares none of its requests; POST is allowed only to requests declared in \"requests\", so list every request the code sends";
      log.push(`Connector code was not tried: ${why}.`);
      previous = { code: proposal.code, failure: `It was not run: ${why}.`, requests: [], log: [] };
      continue;
    }
    const opChange = serves
      ? {
          [input.opId]: {
            servedBy: "connector" as const,
            rowsPath: "$",
            pagination: { kind: "none" as const },
            paginationChecked: true,
            /* The code reads as far as it must; the ceiling is the platform's, not an unconfirmed endpoint's default. */
            maxPages: MAX_PAGES,
            /* A read that sends POST to do its work rests on a reading of the docs, not on the protocol. */
            ...(posts ? { readSafety: { basis: "model-inferred" as const, note: "Read by connector code that sends POST requests to do it." } } : {}),
          },
        }
      : undefined;
    const trial: ConnectionPatch = { auth, connector, ...(opChange ? { ops: opChange } : {}) };
    const next = applyPatch(input.connection, trial);
    if (!next) {
      const why = patchProblem(input.connection, trial) ?? "it did not validate";
      log.push(`Connector code was not tried: the connection it described is not valid (${why}).`);
      previous = { code: proposal.code, failure: `The authority or credentials it declared were not valid: ${why}`, requests: [], log: [] };
      continue;
    }

    const seen: SeenRequests = { requests: [], log: [], events: [] };
    /*
     * Proven from a cold start: a session kept from an earlier attempt would
     * hide the sign-in, which would then never be learned as a request the
     * code sends — and the next read, with no session kept, refused it.
     */
    if (next.auth.type === "connector") for (const token of next.auth.tokens) await input.kit.tokens.forget(token.keyRef);
    const attempt = await tryRead(next, input.opId, { ...input.read, adapter: connectorReader(input.kit, seen) });
    last = attempt;
    const because = `the API needs what a connection cannot describe (${input.problem.replace(/[.\s]+$/, "")}); connector code does it`;
    if (attempt.kind === "needsCredentials") {
      const asked = authCredentials(next.auth).map((one) => one.label);
      log.push(`Connector code written; it needs ${asked.join(" and ")} before it can be tried.`);
      return { connection: next, patch: trial, because, attempt, log, modelCalls };
    }
    log.push(`Tried connector code (${(part === "endpoint" ? connectorHash(proposal.code) : connector.hash).slice(7, 19)}): ${attempt.message}`);
    let read = attempt.kind === "ok" && (attempt.rows?.length ?? 0) > 0 && !stoppedShort(next, input.opId, attempt);
    let broke: string | null = null;
    /*
     * Shared code replaced: every endpoint that read through the old code
     * must read through the new before it is installed, all at once. Code for
     * a second endpoint once replaced the code that read the first.
     */
    if (read && part === "whole" && others.length > 0) {
      for (const other of others) {
        const again = await tryRead(next, other, { ...input.read, adapter: connectorReader(input.kit, seen) });
        if (!(again.kind === "ok" && (again.rows?.length ?? 0) > 0 && !stoppedShort(next, other, again))) {
          broke = `${getOp(next, other)?.title ?? other}: ${again.message}`;
          break;
        }
      }
      if (broke) {
        log.push(`The rewritten code no longer reads what the old code read (${broke}), so it was not kept.`);
        read = false;
      }
    }
    /* Proven: what it sent becomes its templates, and the GET-anywhere it was proven with goes. */
    const events = (seen.events ?? []).map((one) => one.event);
    const learned = !existing && !connector.authority.templates ? templatesFromTrace(events, connector.authority.destinations) : undefined;
    /* Requests nobody declared, learned from what the code sent: held to the same rules as declared ones. */
    const unsound = read && learned ? templatesProblem(learned, { docs: ground, writes: input.writes ?? [], connection: input.connection }) : null;
    if (unsound) {
      log.push(`The connector code sent a request it may not keep sending: ${unsound}`);
      read = false;
    }
    const final: ConnectorSpec = connector.authority.templates
      ? { ...connector, authority: { ...connector.authority, templates: provenTemplates(connector.authority, events) } }
      : learned && learned.length > 0
        ? { ...connector, authority: { ...connector.authority, templates: learned } }
        : connector;
    const patch: ConnectionPatch = { ...trial, connector: final };
    const installed = read ? applyPatch(input.connection, patch) : null;
    if (read && !installed) read = false;
    /*
     * Records, but no word on whether they were all of them: asked once to
     * say, with attempts to spare. Kept either way after that — real records
     * are worth having — and the read still claims nothing about its end.
     */
    const unsaid = read && endUnsaid(next, input.opId, attempt);
    if (read && installed && (!unsaid || unsaidAsked || round + 1 >= input.attempts)) {
      if (unsaid) log.push("The connector code never says whether it read every record, so its reads are shown as possibly incomplete.");
      return { connection: installed, patch, because, attempt, log, modelCalls };
    }
    if (attempt.kind === "budget" || attempt.kind === "rateLimited") return { connection: null, attempt, log, modelCalls };
    if (unsaid && installed) {
      unsaidAsked = true;
      kept = { connection: installed, patch, because, attempt };
    }
    previous = {
      code: proposal.code,
      failure: unsound
        ? `It sent a request a connector may not send: ${unsound} List every request in "requests", only paths the documentation names, and never one that creates, changes or deletes something.`
        : broke
        ? `It read this endpoint, but the endpoints the old code read no longer read with it — ${broke}. Keep every endpoint the shared code reads working, or write only this endpoint's code (part: "endpoint").`
        : unsaid
          ? unsaidFeedback(attempt)
          : stoppedShort(next, input.opId, attempt)
            ? shortFeedback(attempt)
            : attempt.kind === "ok"
              ? "It ran without error but produced no records, and the documentation describes records here."
              : `${attempt.message}${attempt.said && !attempt.message.includes(attempt.said) ? ` — ${attempt.said}` : ""}`,
      requests: seen.requests,
      log: seen.log,
    };
  }
  /* Asked to say how its read ended, and the revision did worse: the code that read records stands. */
  if (kept) {
    log.push("The connector code never says whether it read every record, so its reads are shown as possibly incomplete.");
    return { ...kept, log, modelCalls };
  }
  return { connection: null, attempt: last, log, modelCalls };
};
