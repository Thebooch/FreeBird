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

  // ── OpenAI ──────────────────────────────────────────────────────────────
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    provider: "openai",
    supportsTemperature: true,
    note: "Capable general model.",
  },
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    provider: "openai",
    supportsTemperature: true,
    note: "Cheaper and faster.",
  },
  {
    id: "gpt-4o",
    label: "GPT-4o",
    provider: "openai",
    supportsTemperature: true,
    note: "Widely available.",
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openai",
    supportsTemperature: true,
    note: "Cheapest OpenAI option.",
  },
];

export const DEFAULT_MODEL_BY_PROVIDER: Record<Provider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4.1-mini",
};

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
  | "suggest";

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
    note: "Answers questions about a dashboard. Runs on every message.",
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
  openai: { capable: "gpt-4.1", fast: "gpt-4.1-mini" },
};

/** The environment variable that pins one task, e.g. `DASH_MODEL_WIDGET`. */
export const envVarForTask = (task: LlmTask): string => `DASH_MODEL_${task.toUpperCase()}`;
