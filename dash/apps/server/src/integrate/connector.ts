import { HOOKS, proposeConnector, type ConnectorProposal, type LlmAdapter } from "@freebirdai/dash-agent";
import {
  CONNECTOR_CONTRACT,
  MAX_PAGES,
  authCredentials,
  authKeyRefs,
  connectionKeyRef,
  getOp,
  type AuthSpec,
  type ConnectionSpec,
  type ConnectorSpec,
} from "@freebirdai/dash-spec";
import { ConnectorAdapter, connectorHash } from "../connector/adapter.js";
import type { ConnectorRequestEvent, ConnectorTokenStore } from "../connector/host.js";
import type { ConnectorSandbox } from "../connector/sandbox.js";
import type { DocsKnowledge } from "./docs.js";
import { applyPatch, sameSite, type ConnectionPatch } from "./patch.js";
import { tryRead, type Attempt, type ReadDeps } from "./read.js";

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
 * 50 of 230 records (checkpoint 1).
 */
export const stoppedShort = (connection: ConnectionSpec, opId: string, attempt: Attempt): boolean =>
  attempt.kind === "ok" && attempt.meta?.truncated === true && getOp(connection, opId)?.servedBy === "connector";

/** What to tell the model about a read that stopped short. */
const shortFeedback = (attempt: Attempt): string =>
  [
    `It read ${attempt.rows?.length ?? 0} record(s) and then stopped before the end of them.`,
    ...(attempt.meta?.warnings ?? []).map((warning) => `The read said: ${warning}`),
    `A dashboard total over part of the records is wrong. Read every record the endpoint holds: a read() may send as many requests as it needs, up to the run's allowance of 100, and ctx.maxPages (${MAX_PAGES}) is the most pages to read in one run, not a size to stop at.`,
  ].join(" ");

/** What running connector code needs. The server's; the benchmark's own in a run. */
export interface ConnectorKit {
  readonly sandbox: ConnectorSandbox;
  readonly tokens: ConnectorTokenStore;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly seed?: () => number;
}

/** A read through the connector adapter, with its requests and log lines kept for the next attempt. */
export const connectorReader = (
  kit: ConnectorKit,
  seen?: { requests: string[]; log: string[] },
): NonNullable<ReadDeps["adapter"]> => (http) =>
  new ConnectorAdapter(http, {
    sandbox: kit.sandbox,
    tokens: kit.tokens,
    ...(kit.now ? { now: kit.now } : {}),
    ...(kit.sleep ? { sleep: kit.sleep } : {}),
    ...(kit.seed ? { seed: kit.seed } : {}),
    ...(seen
      ? {
          onRequest: (_connection, _op, event: ConnectorRequestEvent) => {
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

/** Load the code once to learn which hooks it defines — and whether it loads at all. */
const hooksOf = async (kit: ConnectorKit, code: string): Promise<ConnectorSpec["hooks"] | string> => {
  try {
    const session = await kit.sandbox.open({
      code,
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

export const authorConnector = async (input: AuthoringInput): Promise<Authored> => {
  const log: string[] = [];
  let modelCalls = 0;
  let previous: { code: string; failure: string; requests: string[]; log: string[] } | undefined;
  let last: Attempt | null = null;
  /* The prose, and the reference beside it: code needs every endpoint's inputs and answers, not only the overview. */
  const outline = await input.docs.outline();
  const docsText = [(await input.docs.text()).slice(0, 6_000), outline ? `THE SPECIFICATION, ENDPOINT BY ENDPOINT:\n${outline}` : ""]
    .filter((one) => one !== "")
    .join("\n\n");
  const op = getOp(input.connection, input.opId);
  if (!op) return { connection: null, attempt: null, log, modelCalls };
  const existing = input.connection.connector;
  if (existing && input.connection.auth.type === "connector")
    previous = { code: existing.code, failure: input.problem, requests: [], log: [] };

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

    const refused = authorityProblem(input.connection, proposal, input.docsUrl);
    const hooks = refused ? refused : await hooksOf(input.kit, proposal.code);
    if (typeof hooks === "string") {
      log.push(`Connector code was not tried: ${hooks}`);
      previous = { code: proposal.code, failure: `It was not run: ${hooks}`, requests: [], log: [] };
      continue;
    }

    const auth = connectorAuth(input.connection, proposal);
    const serves = proposal.serves || hooks.includes("read");
    const posts = proposal.destinations.some((one) => one.role === "api" && one.methods.includes("POST"));
    const connector: ConnectorSpec = {
      code: proposal.code,
      hash: connectorHash(proposal.code),
      hooks,
      serves: serves ? [input.opId] : [],
      authority: {
        destinations: proposal.destinations.map((one) => ({
          host: one.host.toLowerCase(),
          role: one.role,
          methods: [...new Set(one.methods)],
          credentials: one.role === "download" ? [] : [...new Set(one.credentials)],
        })),
        exchanges: (proposal.exchanges ?? []).map((one) => ({ name: one.name, fields: one.fields ?? [] })),
        retries: 1,
        requests: 100,
        sleepMs: 30_000,
        wallMs: 60_000,
      },
      summary: proposal.summary.slice(0, 600),
      author: { by: "model", model: input.llm.defaultModel.slice(0, 80), at: new Date(input.now()).toISOString() },
    };
    const patch: ConnectionPatch = {
      auth,
      connector,
      ...(serves
        ? {
            ops: {
              [input.opId]: {
                servedBy: "connector",
                rowsPath: "$",
                pagination: { kind: "none" },
                paginationChecked: true,
                /* The code reads as far as it must; the ceiling is the platform's, not an unconfirmed endpoint's default. */
                maxPages: MAX_PAGES,
                /* A read that sends POST to do its work rests on a reading of the docs, not on the protocol. */
                ...(posts ? { readSafety: { basis: "model-inferred", note: "Read by connector code that sends POST requests to do it." } } : {}),
              },
            },
          }
        : {}),
    };
    const next = applyPatch(input.connection, patch);
    if (!next) {
      log.push("Connector code was not tried: the connection it described did not validate.");
      previous = { code: proposal.code, failure: "The authority or credentials it declared were not valid.", requests: [], log: [] };
      continue;
    }

    const seen = { requests: [] as string[], log: [] as string[] };
    const attempt = await tryRead(next, input.opId, { ...input.read, adapter: connectorReader(input.kit, seen) });
    last = attempt;
    const because = `the API needs what a connection cannot describe (${input.problem.replace(/[.\s]+$/, "")}); connector code does it`;
    if (attempt.kind === "needsCredentials") {
      const asked = authCredentials(next.auth).map((one) => one.label);
      log.push(`Connector code written; it needs ${asked.join(" and ")} before it can be tried.`);
      return { connection: next, patch, because, attempt, log, modelCalls };
    }
    log.push(`Tried connector code (${connector.hash.slice(7, 19)}): ${attempt.message}`);
    if (attempt.kind === "ok" && (attempt.rows?.length ?? 0) > 0 && !stoppedShort(next, input.opId, attempt))
      return { connection: next, patch, because, attempt, log, modelCalls };
    if (attempt.kind === "budget" || attempt.kind === "rateLimited") return { connection: null, attempt, log, modelCalls };
    previous = {
      code: proposal.code,
      failure: stoppedShort(next, input.opId, attempt)
        ? shortFeedback(attempt)
        : attempt.kind === "ok"
          ? "It ran without error but produced no records, and the documentation describes records here."
          : `${attempt.message}${attempt.said && !attempt.message.includes(attempt.said) ? ` — ${attempt.said}` : ""}`,
      requests: seen.requests,
      log: seen.log,
    };
  }
  return { connection: null, attempt: last, log, modelCalls };
};
