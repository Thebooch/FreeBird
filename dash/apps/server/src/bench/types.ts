import type { HttpFetch } from "@freebirdai/connect/adapters";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { ConnectionSpec, WidgetSpec } from "@freebirdai/dash-spec";
import type { CredentialBroker } from "@freebirdai/connect/host";
import type {
  BenchRequest,
  BenchResponse,
  IntegrationEnv,
  MockProvider,
  Objective,
  ScenarioInput,
  ScriptedChoice,
  Split,
} from "@freebirdai/connect-bench";

export type { BenchRequest, BenchResponse, IntegrationEnv, MockProvider, Objective, ScenarioInput, ScriptedChoice, Split };

/**
 * The onboarding benchmark's run: what an integrator is given, what it hands
 * back, and how it is scored. The scenarios themselves — the mock APIs, their
 * answer keys and the public APIs — are the engine's test bed, in
 * `@freebirdai/connect-bench`.
 */


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
