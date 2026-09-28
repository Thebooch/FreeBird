import type { HttpFetch } from "@freebirdai/dash-adapters";
import { proposeRepair, type LlmAdapter } from "@freebirdai/dash-agent";
import {
  authCredentials,
  connectionNeedsAddress,
  evidenceSchema,
  fingerprintConnection,
  getOp,
  pathParamNames,
  type AuthCredential,
  type AuthSpec,
  type CatalogEntry,
  type ConnectionSpec,
  type Evidence,
  type EvidenceLevel,
  type PaginationSpec,
} from "@freebirdai/dash-spec";
import { signInGapNotes } from "../discovery/openapi.js";
import { cursorPaths, probePagination, reportedTotal } from "../discovery/probe-pagination.js";
import { authorConnector, connectorReader, stoppedShort, type ConnectorKit } from "./connector.js";
import { docsKnowledge } from "./docs.js";
import { applyPatch, describePatch, sameSite, type ConnectionPatch } from "./patch.js";
import { budgetOf, tryRead, type Attempt, type DiagnosisKind, type ReadDeps } from "./read.js";
import { DEFAULT_STRATEGIES, type RepairStrategy } from "./strategies.js";

/**
 * The integration loop: discover → propose → execute → inspect → repair →
 * verify, over one connection.
 *
 * Given a connection made from documentation and the credentials somebody
 * pasted, it reads the endpoints that matter the way a board will, and when a
 * read fails it does what a developer would: tries the address the docs
 * name, the other ways a key is sent, the header the API asked for, where the
 * records really are — keeping a change only when a real request then gets
 * further. When nothing built-in works it asks a model for one change, with
 * the same rule. Then it confirms how each endpoint pages by reading its
 * second page, and records what was observed as evidence.
 *
 * It asks a person nothing; what only a person can give — an account address,
 * consent, what a word means to them — is not its to guess, and a connection
 * that needs one is reported as blocked, with the reason in plain words.
 * Every request counts against a budget, every change is logged, and nothing
 * is written anywhere: the caller decides whether to keep the result.
 */

export interface IntegrateDeps {
  readonly http: HttpFetch;
  readonly resolveSecret: (keyRef: string) => Promise<string | null>;
  readonly fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>;
  readonly now: () => number;
  /** For the last-resort repair. Absent means built-in repairs only. */
  readonly llm?: LlmAdapter | null | undefined;
  /** Replaces the built-in repairs. See `strategies.ts`. */
  readonly strategies?: readonly RepairStrategy[] | undefined;
  readonly workspace?: string | undefined;
  /** Wraps each read — the server's gate and cooldown. See `ReadDeps.around`. */
  readonly around?: (<T>(run: () => Promise<T>) => Promise<T>) | undefined;
  /** Told of each read the check sends. See `ReadDeps.onRead`. */
  readonly onRead?: ReadDeps["onRead"];
  /** A new token after a refusal. See `ReadDeps.refresh`. */
  readonly refresh?: ReadDeps["refresh"];
  /**
   * Running connector code: the sandbox and where its tokens are kept. With it,
   * every read goes through the connector adapter — as a board's does — and an
   * API no repair can express gets connector code written for it. Without it,
   * the loop repairs within the connection's own vocabulary only.
   */
  readonly connectors?: ConnectorKit | undefined;
  /** The model that writes connector code, when it is not `llm`. */
  readonly connectorLlm?: LlmAdapter | null | undefined;
}

export interface IntegrateOptions {
  /** Endpoints to settle, the most important first. The first decides whether the connection works. */
  readonly targets: readonly string[];
  readonly entry?: CatalogEntry | null | undefined;
  readonly docsUrl?: string | undefined;
  /** Requests to the API, pages included. */
  readonly requests?: number | undefined;
  readonly modelCalls?: number | undefined;
  /** Read a collection to its end to confirm it when it takes no more pages than this. */
  readonly traverseUpTo?: number | undefined;
  /** Times connector code may be written and tried for the first endpoint. */
  readonly connectorAttempts?: number | undefined;
}

export interface OpOutcome {
  readonly op: string;
  readonly title: string;
  readonly outcome: "ready" | "blocked" | "skipped";
  readonly level?: EvidenceLevel;
  readonly note: string;
}

export interface IntegrationReport {
  readonly connection: ConnectionSpec;
  readonly changed: boolean;
  /** Each change kept, in words. */
  readonly changes: readonly string[];
  readonly ops: readonly OpOutcome[];
  readonly evidence: readonly Evidence[];
  readonly outcome: "ready" | "partial" | "blocked";
  /** Why the connection does not work yet, when it does not. */
  readonly blocked?: string;
  /** Everything tried, in order. */
  readonly log: readonly string[];
  readonly requests: number;
  readonly modelCalls: number;
  /**
   * Values the connection now asks for that nobody has pasted: set when
   * connector code declared a sign-in the connection did not have. The
   * person is asked for these, and the next check tries the code.
   */
  readonly needsCredentials?: readonly AuthCredential[];
}

/** How much further a read got. A change is kept only when it moves a read up this list. */
const PROGRESS: Record<DiagnosisKind, number> = {
  ok: 7,
  noRows: 6,
  forbidden: 5,
  badRequest: 4,
  missingInput: 4,
  rateLimited: 3,
  noSignIn: 0,
  signInNeeded: 0,
  needsCredentials: 0,
  unauthorized: 3,
  notFound: 1,
  notJson: 1,
  unreachable: 1,
  failed: 0,
  budget: -1,
};

/** Page sizes APIs default to; a first page of exactly this many is probably not all of it. */
const ROUND_SIZES = new Set([10, 20, 25, 30, 50, 100, 200, 250, 500, 1000]);

const BLOCKED_WORDS: Partial<Record<DiagnosisKind, string>> = {
  unauthorized: "The API refused the key, whichever way it was sent. Check the key, and how its documentation says to send it.",
  forbidden: "The API recognised the key but will not allow this endpoint. The account may not have access to it.",
  notFound: "No address tried answered for this endpoint.",
  notJson: "The API answered with something other than data.",
  unreachable: "The API could not be reached.",
  rateLimited: "The API asked us to wait. Try again later.",
  missingInput: "This endpoint needs a value a board cannot supply by itself.",
  noSignIn: "The documentation does not describe a sign-in Dash can send, so no request was made.",
  signInNeeded: "Sign in with the service to finish connecting it. The check runs again by itself once you have.",
  budget: "The check used up its requests before finishing.",
};

/** A model's proposal, as a change: only fields the connection already has, only to the same organisation. */
const patchFromProposal = (
  proposal: {
    baseUrl?: string | undefined;
    authStyle?: string | undefined;
    authName?: string | undefined;
    authPrefix?: string | undefined;
    headerName?: string | undefined;
    headerValue?: string | undefined;
    rowsPath?: string | undefined;
  },
  connection: ConnectionSpec,
  opId: string,
  docsUrl: string | undefined,
): ConnectionPatch | null => {
  const patch: {
    baseUrl?: string;
    auth?: AuthSpec;
    headers?: Record<string, string>;
    ops?: Record<string, { rowsPath: string }>;
  } = {};
  if (proposal.baseUrl) {
    try {
      const host = new URL(proposal.baseUrl).hostname;
      const known = [connection.baseUrl, docsUrl].flatMap((url) => {
        try {
          return url ? [new URL(url).hostname] : [];
        } catch {
          return [];
        }
      });
      if (proposal.baseUrl.startsWith("https://") && known.some((one) => sameSite(one, host)))
        patch.baseUrl = proposal.baseUrl.replace(/\/+$/, "");
    } catch {
      /* not an address */
    }
  }
  const auth = connection.auth;
  if (proposal.authStyle && (auth.type === "bearer" || auth.type === "header" || auth.type === "query")) {
    const keyRef = auth.keyRef;
    if (proposal.authStyle === "bearer") patch.auth = { type: "bearer", keyRef };
    else if (proposal.authStyle === "header" && proposal.authName)
      patch.auth = {
        type: "header",
        header: proposal.authName,
        keyRef,
        ...(proposal.authPrefix ? { template: `${proposal.authPrefix.trim()} {{key}}` } : {}),
      };
    else if (proposal.authStyle === "query" && proposal.authName)
      patch.auth = { type: "query", param: proposal.authName, keyRef };
  }
  if (proposal.headerName && proposal.headerValue) patch.headers = { [proposal.headerName]: proposal.headerValue };
  if (proposal.rowsPath && proposal.rowsPath.startsWith("$")) patch.ops = { [opId]: { rowsPath: proposal.rowsPath } };
  return Object.keys(patch).length > 0 ? patch : null;
};

/** The request as configured, for a model: addresses, names and constants — never a secret. */
const describeRequest = (connection: ConnectionSpec, opId: string): string => {
  const op = getOp(connection, opId);
  const auth = connection.auth;
  const how =
    auth.type === "bearer"
      ? "a bearer token in the Authorization header"
      : auth.type === "header"
        ? `the key in the ${auth.header} header${auth.template ? ` as "${auth.template.replace("{{key}}", "<key>")}"` : ""}`
        : auth.type === "query"
          ? `the key as the ${auth.param} query parameter`
          : auth.type === "basic"
            ? "HTTP Basic with a username and password"
            : auth.type === "headers"
              ? `keys in ${auth.parts.map((part) => part.header).join(", ")}`
              : "no key";
  return [
    `GET ${connection.baseUrl ?? ""}${op?.path ?? ""}`,
    `Sign-in: ${how}.`,
    `Headers sent: ${Object.keys(op?.headers ?? {}).join(", ") || "none"}.`,
    `Records read at: ${op?.rowsPath ?? "$"}.`,
  ].join("\n");
};

export const integrate = async (
  initial: ConnectionSpec,
  options: IntegrateOptions,
  deps: IntegrateDeps,
): Promise<IntegrationReport> => {
  let connection = initial;
  const budget = budgetOf(options.requests ?? 60);
  const readDeps: ReadDeps = {
    http: deps.http,
    resolveSecret: deps.resolveSecret,
    now: deps.now,
    budget,
    ...(deps.connectors ? { adapter: connectorReader(deps.connectors) } : {}),
    ...(deps.around ? { around: deps.around } : {}),
    ...(deps.onRead ? { onRead: deps.onRead } : {}),
    ...(deps.refresh ? { refresh: deps.refresh } : {}),
  };
  const docsUrl = options.docsUrl ?? options.entry?.docsUrl;
  const docs = docsKnowledge({
    docsUrl,
    specUrl: options.entry?.specUrl,
    known: [options.entry?.keyHelp, options.entry?.notes].filter((one): one is string => !!one),
    fetchDocument: deps.fetchDocument,
  });
  const strategies = deps.strategies ?? DEFAULT_STRATEGIES;
  const maxModelCalls = options.modelCalls ?? 3;
  const log: string[] = [];
  const changes: string[] = [];
  const tried = new Set<string>([fingerprintConnection(connection)]);
  let modelCalls = 0;
  let cannot: string | null = null;
  const plain = { op: { pagination: { kind: "none" } as PaginationSpec, maxPages: 1 } };

  const keep = (next: ConnectionSpec, because: string, patch: ConnectionPatch) => {
    connection = next;
    const titleOf = (op: string) => getOp(next, op)?.title ?? op;
    changes.push(`${because.replace(/[.\s]+$/, "")} — ${describePatch(patch, titleOf)}`);
  };

  /** Try one change; keep it when the read gets further. */
  const attemptChange = async (
    patch: ConnectionPatch,
    because: string,
    opId: string,
    current: Attempt,
  ): Promise<Attempt | null> => {
    const next = applyPatch(connection, patch);
    if (!next) return null;
    const key = fingerprintConnection(next);
    if (tried.has(key)) return null;
    tried.add(key);
    const again = await tryRead(next, opId, readDeps, plain);
    log.push(`Tried ${describePatch(patch, (op) => getOp(next, op)?.title ?? op)} (${because}): ${again.message}`);
    if (PROGRESS[again.kind] > PROGRESS[current.kind]) {
      keep(next, because, patch);
      return again;
    }
    return again.kind === "budget" ? again : null;
  };

  /*
   * Connector code, when nothing in the connection's own vocabulary can work:
   * written from the documentation, proven by a read, kept only when that read
   * returns records. Once per check — it has its own attempts inside.
   */
  let authoring = 0;
  const escalate = async (opId: string, attempt: Attempt, reason?: string): Promise<Attempt | null> => {
    const writer = deps.connectorLlm ?? deps.llm;
    if (!deps.connectors || !writer || authoring > 0) return null;
    authoring++;
    const gaps = attempt.kind === "noSignIn" ? signInGapNotes(await docs.spec()).join(" ") : "";
    const problem = [reason, gaps, attempt.message].filter((one): one is string => !!one).join(" ");
    const authored = await authorConnector({
      connection,
      opId,
      problem,
      docs,
      docsUrl,
      llm: writer,
      kit: deps.connectors,
      read: readDeps,
      attempts: options.connectorAttempts ?? 3,
      now: deps.now,
    });
    modelCalls += authored.modelCalls;
    log.push(...authored.log);
    if (authored.cannot) cannot = authored.cannot;
    if (!authored.connection || !authored.patch) return null;
    tried.add(fingerprintConnection(authored.connection));
    keep(authored.connection, authored.because ?? "connector code", authored.patch);
    return authored.attempt;
  };

  /** Read one endpoint and repair until it reads, or nothing more helps. */
  const settle = async (opId: string, repairConnection: boolean): Promise<Attempt> => {
    let attempt = await tryRead(connection, opId, readDeps, plain);
    log.push(attempt.message);
    /* A read through connector code that stopped short is not done: its code is revised like a failure. */
    for (let round = 0; round < 8 && (attempt.kind !== "ok" || stoppedShort(connection, opId, attempt)); round++) {
      /*
       * Nothing a repair here can change: a rate limit, a refusal of access,
       * a person who must sign in, or values nobody has pasted yet. Asking a
       * model about any of them spends calls to learn what is known.
       */
      if (["budget", "rateLimited", "forbidden", "signInNeeded", "needsCredentials"].includes(attempt.kind)) break;
      /*
       * Code already runs this connection: what failed is the code, and the
       * fix is a revision of it — not a header or an address around it.
       */
      if (connection.connector && repairConnection) {
        const revised = await escalate(
          opId,
          attempt,
          stoppedShort(connection, opId, attempt)
            ? "The connector code that reads this stopped before the end of its records."
            : "The connector code that reads this failed.",
        );
        if (!revised) break;
        attempt = revised;
        continue;
      }
      /*
       * A sign-in the connection cannot send, or an endpoint whose ids come
       * from other requests: not a repair, but perhaps code. An address only
       * the person knows is neither.
       */
      const needsIds =
        attempt.kind === "missingInput" &&
        !connectionNeedsAddress(connection) &&
        pathParamNames(getOp(connection, opId)?.path ?? "").length > 0;
      if (attempt.kind === "noSignIn" || needsIds) {
        const written = repairConnection ? await escalate(opId, attempt) : null;
        if (!written) break;
        attempt = written;
        continue;
      }
      if (attempt.kind === "missingInput") break;
      const op = getOp(connection, opId)!;
      let improved: Attempt | null = null;
      for (const strategy of strategies) {
        if (!strategy.handles.includes(attempt.kind)) continue;
        if (!repairConnection && strategy.id !== "rows-path") continue;
        for (const candidate of await strategy.propose({ connection, op, attempt, docs, docsUrl })) {
          const result = await attemptChange(candidate.patch, candidate.because, opId, attempt);
          if (result?.kind === "budget") return result;
          if (result) {
            improved = result;
            break;
          }
        }
        if (improved) break;
      }
      if (improved) {
        attempt = improved;
        continue;
      }
      /* Nothing built-in helped: one change from a model, with the same rule. */
      if (!deps.llm || modelCalls >= maxModelCalls || !repairConnection) break;
      modelCalls++;
      const answer = await proposeRepair(deps.llm, {
        apiTitle: connection.title,
        request: describeRequest(connection, opId),
        failure: attempt.message,
        tried: log.filter((line) => line.startsWith("Tried ")).slice(-8),
        docs: await docs.text(),
      });
      if ("error" in answer) {
        log.push(`Asked a model for a repair; ${answer.error}`);
        break;
      }
      if (answer.proposal.cannot) {
        cannot = answer.proposal.cannot;
        log.push(`A model read the documentation and found this cannot be expressed: ${cannot}`);
        const written = await escalate(opId, attempt, cannot);
        if (!written) break;
        attempt = written;
        continue;
      }
      const patch = patchFromProposal(answer.proposal, connection, opId, docsUrl);
      if (!patch) {
        log.push("A model proposed a change that is not allowed here; it was not tried.");
        break;
      }
      const result = await attemptChange(patch, `a model's reading: ${answer.proposal.reason}`, opId, attempt);
      if (result?.kind === "budget") return result;
      if (result) attempt = result;
    }
    return attempt;
  };

  interface Observed {
    readonly op: string;
    readonly level: EvidenceLevel;
    readonly rows: number;
    readonly pages: number;
    readonly reportedTotal?: number;
    readonly pagination?: PaginationSpec;
    readonly note: string;
    readonly by: Evidence["by"];
    readonly maxPages: number;
  }
  const observed: Observed[] = [];
  const outcomes: OpOutcome[] = [];

  /** Confirm how an endpoint that read pages, when there is reason to think it does. */
  const confirmPaging = async (opId: string, first: Attempt): Promise<void> => {
    const op = getOp(connection, opId)!;
    const rows = first.rows?.length ?? 0;
    const stated = reportedTotal(first.body);
    const unconfirmed = !op.paginationChecked;
    const worth =
      unconfirmed &&
      ((connection.paginationPending && op.pagination.kind === "none") ||
        op.pagination.kind !== "none" ||
        (stated !== undefined && stated > rows) ||
        (rows >= 10 && (cursorPaths(first.body).length > 0 || ROUND_SIZES.has(rows))));
    if (!worth) return;
    const proposal =
      op.pagination.kind !== "none" ? op.pagination : (options.entry?.paginationProposal ?? undefined);
    const probe = await probePagination(connection, opId, readDeps, {
      proposal,
      traverseUpTo: options.traverseUpTo ?? 20,
      first,
    });
    log.push(`Paging for ${op.title}: ${probe.note}${probe.tried.length > 0 ? ` (tried ${probe.tried.join("; ")})` : ""}`);
    if (probe.level && probe.level !== "accepted") {
      observed.push({
        op: opId,
        level: probe.level,
        rows: probe.rows,
        pages: probe.pages,
        ...(probe.reportedTotal !== undefined ? { reportedTotal: probe.reportedTotal } : {}),
        ...(probe.pagination ? { pagination: probe.pagination } : {}),
        note: probe.note,
        by: "probe",
        maxPages: probe.maxPages ?? op.maxPages,
      });
    }
    if (probe.pagination) {
      const patch: ConnectionPatch = {
        ops: {
          [opId]: {
            pagination: probe.pagination,
            paginationChecked: true,
            ...(probe.maxPages ? { maxPages: probe.maxPages } : {}),
          },
        },
      };
      const next = applyPatch(connection, patch);
      if (next) keep(next, probe.note, patch);
    }
  };

  const targets = [...new Set(options.targets)].filter((opId) => getOp(connection, opId));
  let blocked: string | undefined;
  for (const [index, opId] of targets.entries()) {
    const primary = index === 0;
    const op = getOp(connection, opId)!;
    if (budget.remaining <= 0) {
      outcomes.push({ op: opId, title: op.title, outcome: "skipped", note: "Not checked: the check's requests were used up." });
      continue;
    }
    const attempt = await settle(opId, primary);
    if (attempt.kind !== "ok") {
      /* A sign-in the importer could not represent: say which, in the manifest's words. */
      const unsupported =
        attempt.kind === "noSignIn" ? signInGapNotes(await docs.spec()).join(" ") : "";
      const waiting =
        attempt.kind === "needsCredentials"
          ? `Paste the ${authCredentials(connection.auth)
              .map((one) => one.label)
              .join(" and ")} from your ${connection.title} account. The check runs again by itself once you have.`
          : "";
      const reason =
        waiting ||
        unsupported ||
        (primary && cannot) ||
        `${BLOCKED_WORDS[attempt.kind] ?? "The API refused the request."}${attempt.said ? ` The API said: ${attempt.said}` : ""}`;
      outcomes.push({ op: opId, title: op.title, outcome: "blocked", note: reason });
      if (primary) {
        blocked = reason;
        break;
      }
      continue;
    }
    /* Code that reads a whole collection and says how many there are: counted against its own word. */
    const servedTotal = getOp(connection, opId)?.servedBy === "connector" ? attempt.meta?.reportedTotal : undefined;
    const rows = attempt.rows?.length ?? 0;
    observed.push({
      op: opId,
      level:
        servedTotal !== undefined && servedTotal === rows && !attempt.meta?.truncated ? "count-reconciled" : "accepted",
      rows,
      pages: attempt.meta?.pages ?? 1,
      ...(servedTotal !== undefined ? { reportedTotal: servedTotal } : {}),
      note: attempt.message,
      by: "integrate",
      maxPages: getOp(connection, opId)?.maxPages ?? 1,
    });
    await confirmPaging(opId, attempt);
    const best = observed.filter((one) => one.op === opId).at(-1);
    outcomes.push({
      op: opId,
      title: op.title,
      outcome: "ready",
      ...(best ? { level: best.level } : {}),
      note: best?.note ?? attempt.message,
    });
  }

  /* Evidence is recorded against the configuration it ends up describing. */
  const configVersion = fingerprintConnection(connection);
  const at = new Date(deps.now()).toISOString();
  const evidence = observed.map((one) =>
    evidenceSchema.parse({
      workspace: deps.workspace ?? "local",
      connection: connection.id,
      op: one.op,
      level: one.level,
      configVersion,
      at,
      limits: { pages: one.pages, maxPages: one.maxPages, requests: budget.spent },
      observed: {
        rows: one.rows,
        ...(one.reportedTotal !== undefined ? { reportedTotal: one.reportedTotal } : {}),
        ...(one.pagination ? { pagination: one.pagination } : {}),
        note: one.note.slice(0, 400),
      },
      by: one.by,
    }),
  );

  const ready = outcomes.filter((one) => one.outcome === "ready").length;
  const outcome: IntegrationReport["outcome"] = blocked
    ? "blocked"
    : ready === outcomes.length
      ? "ready"
      : "partial";
  return {
    connection,
    changed: fingerprintConnection(connection) !== fingerprintConnection(initial),
    changes,
    ops: outcomes,
    evidence,
    outcome,
    ...(blocked ? { blocked } : {}),
    log,
    requests: budget.spent,
    modelCalls,
    ...(blocked && connection.auth.type === "connector" && outcomes[0]?.note.startsWith("Paste the ")
      ? { needsCredentials: authCredentials(connection.auth) }
      : {}),
  };
};
