/**
 * Which models exist, and what each one will actually accept.
 *
 * This is a capability table rather than a list of names because the providers
 * have started *removing* request parameters between generations. Anthropic
 * dropped `temperature` on its newer models and returns a 400 rather than
 * ignoring it — so sending a parameter that used to be harmless is now a hard
 * failure, and "which model" has to be answered before "what to send".
 *
 * The safe direction is to omit: a model that supports `temperature` behaves
 * sensibly without it, but a model that rejects it fails every call. So an
 * unrecognised model id — a custom one, or one released after this table was
 * written — is treated as accepting nothing optional.
 */

export type Provider = "anthropic" | "openai";

export interface ModelInfo {
  readonly id: string;
  readonly label: string;
  readonly provider: Provider;
  /** False means sending `temperature` returns a 400 on this model. */
  readonly supportsTemperature: boolean;
  /** A one-line hint for the picker, not marketing copy. */
  readonly note: string;
}

export const MODELS: readonly ModelInfo[] = [
  // ── Anthropic ───────────────────────────────────────────────────────────
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    provider: "anthropic",
    supportsTemperature: false,
    note: "Most capable. Best at reading messy documentation.",
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    supportsTemperature: false,
    note: "Balanced. A good default for authoring and discovery.",
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    supportsTemperature: false,
    note: "Previous-generation Opus.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    supportsTemperature: true,
    note: "Previous-generation Sonnet. Still accepts temperature.",
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    supportsTemperature: true,
    note: "Fastest and cheapest. Weaker on ambiguous documentation.",
  },

  /*
   * ── OpenAI ────────────────────────────────────────────────────────────
   *
   * `supportsTemperature: false` on all of these, and it is a statement about
   * what is known rather than about the models. Omitting the parameter is
   * always safe; sending one a model rejects is a 400 that fails the call. It
   * is also what an unlisted id already gets from `capabilitiesFor`, so this
   * preserves current behaviour rather than betting on it. Flip any of them to
   * true once a real call proves it — the calls that ask for `temperature: 0`
   * get their determinism back when you do.
   *
   * Notes carry prices instead of adjectives. Nothing here has been measured
   * on this workload yet, and "capable general model" next to a number nobody
   * checked is the kind of hint that decides a choice badly.
   *
   * The `-pro` models are left out on purpose: at $30/$180 and up they are far
   * dearer than anything else here, and everything in this list is one click
   * away in the picker.
   */
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    supportsTemperature: false,
    note: "Largest of the 5.6 family. $4 in / $20 out per million tokens.",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    supportsTemperature: false,
    note: "Mid 5.6, and the OpenAI capable tier here. $2 in / $12 out.",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    supportsTemperature: false,
    note: "Smallest 5.6, and the OpenAI fast tier. $0.20 in / $1.20 out.",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    provider: "openai",
    supportsTemperature: false,
    note: "Previous generation. $5 in / $30 out — dearer than 5.6 Sol.",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    provider: "openai",
    supportsTemperature: false,
    note: "Previous generation. $2.50 in / $15 out.",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    provider: "openai",
    supportsTemperature: false,
    note: "$0.75 in / $4.50 out.",
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    provider: "openai",
    supportsTemperature: false,
    note: "Cheapest listed. $0.20 in / $1.25 out.",
  },
];

export const DEFAULT_MODEL_BY_PROVIDER: Record<Provider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-terra",
};

/**
 * Whose models to use when nothing more specific has said.
 *
 * A person thinks "I want to run on OpenAI for a while", not "I want
 * gpt-5.6-terra for building widgets and gpt-5.6-luna for chat" — so the
 * provider is one choice above the table, and the per-task rows follow it.
 * Everything below stays available for the case where somebody does want to
 * pin one action to something else.
 *
 * The default is OpenAI. That is a live preference rather than a verdict: the
 * measurements behind `TASKS` were taken on Anthropic and still stand, and
 * this is one edit to move.
 */
export const DEFAULT_PROVIDER: Provider = "openai";

export interface ProviderInfo {
  readonly id: Provider;
  /** What people call it, which is not always what the API is called. */
  readonly label: string;
  /** The key that has to exist for this provider to be reachable. */
  readonly keyVar: string;
  readonly note: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    keyVar: "OPENAI_API_KEY",
    note: "GPT-5.6 Terra for setting up, Luna for using.",
  },
  {
    id: "anthropic",
    label: "Claude",
    keyVar: "ANTHROPIC_API_KEY",
    note: "Sonnet 5 for setting up, Haiku 4.5 for using.",
  },
];

export const findProvider = (id: string): ProviderInfo | undefined =>
  PROVIDERS.find((provider) => provider.id === id);

export const isProvider = (id: unknown): id is Provider =>
  typeof id === "string" && Boolean(findProvider(id));

export const findModel = (id: string): ModelInfo | undefined =>
  MODELS.find((model) => model.id === id);

/**
 * Infer the provider for a model id that is not in the table, so a custom or
 * newly released id still routes to the right API.
 */
export const providerFor = (id: string): Provider | null => {
  const known = findModel(id);
  if (known) return known.provider;
  if (/^claude[-.]/i.test(id)) return "anthropic";
  if (/^(?:gpt|o\d|chatgpt)/i.test(id)) return "openai";
  return null;
};

/**
 * Capabilities for any id, known or not. Unknown ids get the conservative
 * answer — omitting an optional parameter never fails, sending one can.
 */
export const capabilitiesFor = (id: string): { supportsTemperature: boolean } => ({
  supportsTemperature: findModel(id)?.supportsTemperature ?? false,
});

/* ── tasks ──────────────────────────────────────────────────────────────── */

/**
 * The AI actions this server performs, each routed independently.
 *
 * Measured, not guessed: the same prompt against the same candidates picked
 * the wrong endpoint on the cheap model and the right one on the better one,
 * twice, and two prompt rewrites moved neither. Meanwhile the cheap model
 * answered questions about a board correctly and named four hundred fields
 * without a miss. **The cheap model is fine at reading and weak at deciding.**
 *
 * The line falls almost exactly where the product's own does. Everything in
 * the `capable` tier happens at *setup* — connecting an API, mapping it,
 * building a widget — which is rare and one-off. Everything in `fast` happens
 * at *use*, which is constant. Paying for judgement once and reading cheaply
 * forever is the whole shape of this.
 */
export type LlmTask =
  | "widget"
  | "discover"
  | "map"
  | "record"
  | "label"
  | "chat"
  | "narrow"
  | "suggest"
  | "context"
  | "respond";

/**
 * Two tiers, not three.
 *
 * A middle tier would resolve to the same model as `capable` on Anthropic,
 * and a dial that does nothing is worse than no dial. Anyone who wants Opus
 * for one task can pick it per task; nothing measured here says it beats
 * Sonnet at any of these, so nothing defaults to it.
 */
export type Tier = "capable" | "fast";

export interface TaskInfo {
  readonly id: LlmTask;
  /** For the picker. A person's name for the action, not the label. */
  readonly label: string;
  readonly tier: Tier;
  /** When this runs, in the user's terms — the reason the tier is what it is. */
  readonly note: string;
}

export const TASKS: readonly TaskInfo[] = [
  {
    id: "widget",
    label: "Building a widget",
    tier: "capable",
    note: "Chooses the endpoints and binds the fields. The hardest judgement here.",
  },
  {
    id: "discover",
    label: "Reading API documentation",
    tier: "capable",
    note: "Works out how to call an API from its docs page. The messiest input.",
  },
  {
    id: "map",
    label: "Mapping an API",
    tier: "capable",
    note: "Finds how an API's resources relate. Runs once per API.",
  },
  {
    id: "record",
    label: "Designing a record view",
    tier: "capable",
    note: "Chooses what opening a row shows. Runs once, when a widget is saved.",
  },
  {
    id: "label",
    label: "Naming fields",
    tier: "fast",
    note: "Turns an API's field names into readable ones. Hundreds at a time.",
  },
  {
    id: "chat",
    label: "Chat",
    tier: "fast",
    note: "Decides what a message needs and which tools to call. Every message.",
  },
  {
    /*
     * Several calls per question - rank, judge, rank again - against material
     * that is already in memory. Reading and matching, which is where the
     * cheap model measured well; the judgement that matters is downstream.
     */
    id: "context",
    label: "Finding an answer in your data",
    tier: "fast",
    note: "Picks where to look and checks whether it found it. Several calls per question.",
  },
  {
    /*
     * The one call the user actually reads. Everything else this session does
     * is a step toward it, and a flat or hedged sentence undoes all of them -
     * so this is the one place in the "use" half that pays for the better
     * model.
     */
    id: "respond",
    label: "Writing the reply",
    tier: "capable",
    note: "Turns what was found into the answer the user reads. Once per message.",
  },
  {
    id: "narrow",
    label: "Matching a phrase to data",
    tier: "fast",
    note: "Decides which real values a word like “maintenance” covers.",
  },
  {
    id: "suggest",
    label: "Reviewing suggestions",
    tier: "fast",
    note: "A second opinion on a proposed resource map.",
  },
];

export const findTask = (id: string): TaskInfo | undefined =>
  TASKS.find((task) => task.id === id);

export const isTask = (id: string): id is LlmTask => Boolean(findTask(id));

/**
 * Which model each tier means, per provider.
 *
 * Deliberately expressed as tiers rather than eight defaults: when a provider
 * ships a new generation this is two edits, and no task can be forgotten.
 */
export const TIER_MODELS: Record<Provider, Record<Tier, string>> = {
  anthropic: { capable: "claude-sonnet-5", fast: "claude-haiku-4-5" },
  openai: { capable: "gpt-5.6-terra", fast: "gpt-5.6-luna" },
};

/** The environment variable that pins one task, e.g. `DASH_MODEL_WIDGET`. */
export const envVarForTask = (task: LlmTask): string => `DASH_MODEL_${task.toUpperCase()}`;
