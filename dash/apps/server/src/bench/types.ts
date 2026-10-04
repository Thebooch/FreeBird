import type { HttpFetch } from "@freebirdai/dash-adapters";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { ConnectionSpec, WidgetSpec } from "@freebirdai/dash-spec";
import type { CredentialBroker } from "../auth/broker.js";

/**
 * The onboarding benchmark's vocabulary. See `dash/bench/PROTOCOL.md`: that
 * document is the contract, and these types are its shape.
 */

/** `real`: public APIs reached over the network, run by hand. See `providers/real.ts`. */
export type Split = "dev" | "heldout" | "real";

export interface BenchRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
}

export interface BenchResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** A string is sent as-is; anything else as JSON. */
  readonly body: unknown;
}

/** The endpoint and measure a correct integrator would choose. CI only; never shown to a model. */
export interface ScriptedChoice {
  /** Matched against a connection op's path, ignoring `{{param.x}}` blanks. */
  readonly path: string;
  readonly measure: {
    readonly agg: "count" | "sum";
    readonly field?: string;
    /** A runtime filter expression over the record, e.g. `status == "open"`. */
    readonly where?: string;
  };
}

export interface Objective {
  readonly id: string;
  /** What the person asks for, in their words. */
  readonly request: string;
  /**
   * The correct number, computed from the seed by reference code in the
   * provider's own file — never by the pipeline being measured.
   */
  readonly answer: number;
  /** Absolute. Zero for a count. */
  readonly tolerance: number;
  /** How many records the collection the objective reads really holds. */
  readonly records: number;
  readonly scripted: ScriptedChoice;
}

export interface MockProvider {
  readonly id: string;
  readonly split: Split;
  /** Why this provider is in the corpus: the pattern it exercises. */
  readonly pattern: string;
  /** Every host it answers for — its API and its docs. */
  readonly hosts: readonly string[];
  /** Where a person would start: the documentation URL they paste. */
  readonly docsUrl: string;
  /** What the person pastes, in the order they are asked. */
  readonly credentials: readonly string[];
  /**
   * What the provider's settings page calls each credential, beside it. A
   * person reads these to paste each value into the field asking for it;
   * absent, values are pasted in the order asked.
   */
  readonly credentialLabels?: readonly string[];
  readonly objectives: readonly Objective[];
  /**
   * Scripted model answers for the discovery rungs that need one, keyed by
   * tool name. CI only; a live run uses a real model instead.
   */
  readonly scriptedModel?: Readonly<Record<string, unknown>>;
  /**
   * Deterministic: the same requests, in the same order after `reset`, get
   * the same answers. A provider with state (an export being prepared) keeps
   * it only between resets.
   */
  handle(request: BenchRequest): BenchResponse;
  /** Forget any state, before each scenario. */
  reset?(): void;
  /** Reached over the network rather than in-process: a real API. */
  readonly live?: boolean;
  /**
   * Its documentation is drawn by scripts, so reading it needs Playwright's
   * Chromium: skipped, and said, where none is installed. The benchmark never
   * downloads one.
   */
  readonly needs?: "browser";
  /**
   * Whether the data behind the answer keys is still what the API holds: null
   * when it is, the reason when not. A stale key is reported, never scored.
   */
  readonly freshness?: (http: HttpFetch) => Promise<string | null>;
  /**
   * How a developer who read the docs would configure it, by hand.
   *
   * Never shown to an integrator. It exists to prove the answer keys: the
   * reference connection plus the scripted choice must reach every answer,
   * or the key — not the integrator — is wrong. Absent where no connection
   * Dash can express reaches the data yet.
   */
  readonly reference?: {
    readonly connection: Readonly<Record<string, unknown>>;
    readonly secrets: Readonly<Record<string, string>>;
  };
  /**
   * The address of the person's own account, for an API where each account
   * lives at its own address — what they would type when asked. Absent, the
   * reference connection's address is theirs.
   */
  readonly accountAddress?: string;
}

/** What an integrator is allowed to see of a scenario. The answer is not in it. */
export interface ScenarioInput {
  readonly provider: string;
  readonly docsUrl: string;
  readonly credentials: readonly string[];
  /** See `MockProvider.credentialLabels`. */
  readonly credentialLabels?: readonly string[];
  /** What the person types when asked which address their account is at. See `MockProvider.accountAddress`. */
  readonly accountAddress?: string;
  readonly objective: {
    readonly id: string;
    readonly request: string;
    /** Present only in scripted mode. */
    readonly scripted?: ScriptedChoice;
  };
}

export interface IntegrationEnv {
  /** Reaches only the benchmark's providers; nothing else is on the network. */
  readonly http: HttpFetch;
  readonly fetchDocument: (url: string) => Promise<{ status: number; text: string; url: string }>;
  readonly llm: LlmAdapter | null;
  readonly now: number;
}

export type InterventionKind = "technical" | "intent" | "consent" | "account";

export interface Intervention {
  readonly kind: InterventionKind;
  readonly what: string;
}

export interface IntegrationOutcome {
  readonly connection: ConnectionSpec | null;
  /** The widget answering the objective. */
  readonly widget: WidgetSpec | null;
  /** Secrets by vault reference, as the connection will ask for them. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly interventions: readonly Intervention[];
  /** What the integrator said along the way. */
  readonly notes: readonly string[];
  /** Where it stopped, when it did. */
  readonly stoppedAt?: string;
  readonly modelCalls: number;
  /** How the connection's secrets turn into what is sent — live tokens, for OAuth. */
  readonly broker?: CredentialBroker;
}

export interface Integrator {
  readonly id: string;
  integrate(input: ScenarioInput, env: IntegrationEnv): Promise<IntegrationOutcome>;
}

export type Completeness = "complete" | "incomplete-flagged" | "incomplete-silent" | "n/a";

export interface ScenarioScore {
  readonly provider: string;
  readonly objective: string;
  readonly split: Split;
  readonly integrator: string;
  readonly setup: "done" | `stopped:${string}`;
  readonly interventions: Readonly<Record<InterventionKind, number>>;
  readonly retrieval: "ok" | "error" | "none";
  readonly completeness: Completeness;
  readonly metric: "correct" | "wrong" | "n/a";
  readonly value: number | null;
  readonly expected: number;
  /** Records the widget read, against how many the provider holds. */
  readonly recordsRead: number | null;
  readonly records: number;
  /** What the product said about not having everything. */
  readonly flagged: readonly string[];
  /**
   * What the tile said about its number beyond that: a narrowing it could not
   * apply, parts that do not add up to a total. A wrong number that says why
   * is not a silent one (PROTOCOL.md).
   */
  readonly said?: readonly string[];
  readonly error?: string;
  /** How the scored read ended (`FetchMeta.completion`), and what carrying it on past its own limit met. */
  readonly ended?: string;
  /** What the integrator said along the way: kept on a failure, and wherever a model was used. */
  readonly log?: readonly string[];
  readonly requests: number;
  readonly modelCalls: number;
  readonly ms: number;
  readonly success: boolean;
}
