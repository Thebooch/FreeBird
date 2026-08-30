import { useEffect, useState } from "react";
import {
  type ModelOption,
  type ModelWriteResult,
  type ModelsResult,
  type TaskOption,
  api,
} from "./api.js";

/**
 * Whose models to run, and which one runs which AI action.
 *
 * This was one global choice, and the comment here said per-action selection
 * was a later problem because knowing *which* model wrote a binding mattered
 * more. Both halves turned out to be right and to point the same way: the
 * actions are not alike — picking endpoints and binding fields is judgement,
 * answering a question about a board is reading — and a widget now records the
 * model that produced it, so the provenance objection is answered rather than
 * traded away.
 *
 * The provider sits above all of it, because that is the choice people
 * actually make: "run this on OpenAI for a while", not eight model ids. Pick
 * one and every action below follows it.
 *
 * Defaults lead. Nothing here has to be touched for the routing to be good;
 * every row shows what will run and says why, and the panel exists for the
 * person who wants to spend more on one action or less on another.
 */

const SOURCE_NOTE: Record<TaskOption["source"], string> = {
  env: "Pinned in the environment",
  task: "Chosen for this action",
  global: "The one model set above",
  tier: "Default",
  none: "No AI key",
};

/** Models grouped by provider, with unavailable ones shown but not selectable. */
const ModelOptions = ({ models }: { readonly models: readonly ModelOption[] }): JSX.Element => {
  const grouped = {
    anthropic: models.filter((model) => model.provider === "anthropic"),
    openai: models.filter((model) => model.provider === "openai"),
  };
  return (
    <>
      {(["anthropic", "openai"] as const).map((provider) => (
        <optgroup key={provider} label={provider === "anthropic" ? "Anthropic" : "OpenAI"}>
          {grouped[provider].map((model) => (
            <option key={model.id} value={model.id} disabled={!model.available}>
              {model.label}
              {model.available ? "" : " — needs a key"}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
};

const money = (usd: number): string =>
  usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

const TaskRow = ({
  task,
  models,
  spend,
  disabled,
  onChoose,
}: {
  readonly task: TaskOption;
  readonly models: readonly ModelOption[];
  readonly spend: { usd: number; calls: number } | undefined;
  readonly disabled: boolean;
  readonly onChoose: (model: string | null, task?: string) => Promise<void>;
}): JSX.Element => (
  <label className="dash-models__row" data-testid={`model-task-${task.id}`}>
    <span className="dash-models__name">
      {task.label}
      <small className="dash-models__note">{task.note}</small>
      <small className="dash-models__note">
        {SOURCE_NOTE[task.source]}
        {task.effective ? `: ${task.effective}` : ""}
        {spend && spend.calls > 0 ? ` · ${money(spend.usd)} so far` : ""}
        {task.available ? "" : " · needs a key"}
      </small>
    </span>
    <select
      className="dash-control"
      aria-label={task.label}
      disabled={disabled}
      value={task.selected ?? ""}
      onChange={(event) => void onChoose(event.target.value || null, task.id)}
    >
      {/* Named rather than left as a bare "Default", so the row still reads as
          an answer when nobody has chosen anything — which is most rows. */}
      <option value="">
        Default{task.source === "tier" && task.effective ? ` (${task.effective})` : ""}
      </option>
      <ModelOptions models={models} />
    </select>
  </label>
);

export interface ModelPickerProps {
  /**
   * Dressing for the trigger, so the same control can be a bar button or a row
   * in the nav's overflow menu.
   */
  readonly className?: string;
  /**
   * Announced whenever the sheet opens or closes.
   *
   * The trigger now lives inside a popover that closes on an outside click,
   * and the sheet renders *within* that popover — so a popover that closed
   * behind the sheet would unmount the sheet along with it. The nav holds its
   * menu open while this says the sheet is up.
   */
  readonly onOpenChange?: (open: boolean) => void;
}

export const ModelPicker = ({
  className = "dash-control",
  onOpenChange,
}: ModelPickerProps = {}): JSX.Element | null => {
  const [state, setState] = useState<ModelsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const show = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };
  /** What a provider switch had to drop, said once rather than left to be found. */
  const [notice, setNotice] = useState<string | null>(null);

  const load = (): void => {
    void api
      .models()
      .then(setState)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  useEffect(load, []);

  // Reopening is the moment somebody wants to know what has been spent, so the
  // totals are re-read then rather than left at whatever they were on load.
  useEffect(() => {
    if (open) load();
  }, [open]);

  /*
   * A placeholder row rather than nothing.
   *
   * This is a row in the nav's overflow menu now, and the menu mounts it on
   * open — so returning null until the fetch landed moved every item below it
   * down under whatever the cursor was already over. It also gives a failed
   * read somewhere to say so, which returning null never did.
   */
  if (!state) {
    return (
      <span
        className={className}
        data-testid="model-picker-loading"
        title={error ?? "Reading which model runs which action"}
      >
        {error ? "⚠ Models unavailable" : "⚙ Models…"}
      </span>
    );
  }

  if (!state.providers.anthropic && !state.providers.openai) {
    return (
      <span className={className} data-testid="model-picker-disabled" title="No AI key is set">
        ⚠ No AI key
      </span>
    );
  }

  /*
   * Every write returns the whole routing, so nothing here re-fetches to find
   * out what it just did. A provider switch changes far more rows than it
   * touches, and a picker that showed the old answers until the next open
   * would be the same complaint that led to this panel.
   */
  const apply = (result: ModelWriteResult): void => {
    setState({
      ...state,
      provider: result.provider,
      effectiveProvider: result.effectiveProvider,
      defaultProvider: result.defaultProvider,
      selected: result.selected,
      effective: result.effective,
      tasks: result.tasks,
    });

    const cleared = result.clearedTasks
      .map((id) => state.tasks.find((task) => task.id === id)?.label ?? id)
      .concat(result.clearedGlobal ? ["the one-model-for-everything choice"] : []);
    setNotice(
      cleared.length === 0
        ? null
        : `Dropped ${cleared.join(", ")} — ${cleared.length === 1 ? "it was" : "they were"} pinned to the other provider.`,
    );
  };

  const run = async (write: () => Promise<ModelWriteResult>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      apply(await write());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const choose = (model: string | null, task?: string): Promise<void> =>
    run(() => api.setModel(model, task));

  const chooseProvider = (provider: string): Promise<void> =>
    run(() => api.setProvider(provider === "" ? null : (provider as "anthropic" | "openai")));

  const inForce = state.providerOptions.find(
    (provider) => provider.id === state.effectiveProvider,
  );
  /* What picking "Default" would give — not what is in force, which is what
     the option said before and was a description of the state instead. */
  const byDefault = state.providerOptions.find(
    (provider) => provider.id === state.defaultProvider,
  );

  /*
   * The button says what is actually happening, in one word.
   *
   * The provider rather than a model name, because naming one of several
   * models on a control that routes to all of them is the sort of half-truth
   * that costs somebody an afternoon — and the provider *is* true of all of
   * them until somebody pins a row to the other one.
   */
  const summary = state.pinnedByEnv
    ? "Pinned"
    : state.selected
      ? (state.models.find((model) => model.id === state.selected)?.label ?? state.selected)
      : (inForce?.label ?? "Per action");

  const tiered = (tier: TaskOption["tier"]): JSX.Element[] =>
    state.tasks
      .filter((task) => task.tier === tier)
      .map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          models={state.models}
          spend={state.spend.byTask[task.id]}
          disabled={busy || state.pinnedByEnv}
          onChoose={choose}
        />
      ));

  return (
    <>
      <button
        className={className}
        data-on={open}
        onClick={() => show(!open)}
        data-testid="model-picker"
        title="Which model runs which AI action"
      >
        ⚙ {summary}
      </button>

      {open && (
        <div className="dash-sheet-backdrop" onClick={() => show(false)} role="presentation">
          <aside
            className="dash-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="AI models"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="dash-sheet__head">
              <div className="dash-sheet__bar">
                <span className="dash-sheet__title">AI models</span>
                <button
                  className="dash-control dash-sheet__close"
                  onClick={() => show(false)}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <span className="dash-sheet__trail">
                Setting up costs more than using. Each action runs on the model that suits it.
              </span>
            </header>

            <div className="dash-sheet__body">
              {error && (
                <p className="dash-callout dash-callout--bad" data-testid="model-picker-error">
                  {error}
                </p>
              )}

              {state.pinnedByEnv && (
                <p className="dash-callout" data-testid="model-picker-pinned">
                  DASH_LLM_MODEL is set in the environment, which overrides everything here.
                </p>
              )}

              {notice && (
                <p className="dash-callout" data-testid="model-picker-notice">
                  {notice}
                </p>
              )}

              {state.provider && state.provider !== state.effectiveProvider && (
                <p className="dash-callout dash-callout--bad" data-testid="model-picker-provider-gone">
                  {state.providerOptions.find((entry) => entry.id === state.provider)?.label} is
                  selected, but its key is missing, so everything is running on{" "}
                  {inForce?.label ?? "nothing"}.
                </p>
              )}

              <section className="dash-sheet__section">
                <h3 className="dash-sheet__sub">Provider</h3>
                <label className="dash-models__row">
                  <span className="dash-models__name">
                    Whose models to use
                    <small className="dash-models__note">
                      Everything below follows this unless it is pinned to something else.
                    </small>
                    <small className="dash-models__note">
                      {state.provider ? "Chosen" : "Default"}
                      {inForce ? `: ${inForce.label} — ${inForce.note}` : ""}
                    </small>
                  </span>
                  <select
                    className="dash-control"
                    aria-label="Provider"
                    data-testid="model-picker-provider"
                    disabled={busy || state.pinnedByEnv}
                    value={state.provider ?? ""}
                    onChange={(event) => void chooseProvider(event.target.value)}
                  >
                    <option value="">Default{byDefault ? ` (${byDefault.label})` : ""}</option>
                    {state.providerOptions.map((provider) => (
                      <option
                        key={provider.id}
                        value={provider.id}
                        disabled={!provider.available}
                      >
                        {provider.label}
                        {provider.available ? "" : ` — needs ${provider.keyVar}`}
                      </option>
                    ))}
                  </select>
                </label>
              </section>

              <section className="dash-sheet__section">
                <h3 className="dash-sheet__sub">Every action</h3>
                <label className="dash-models__row">
                  <span className="dash-models__name">
                    Use one model for everything
                    <small className="dash-models__note">
                      Overrides the per-action defaults below.
                    </small>
                  </span>
                  <select
                    className="dash-control"
                    aria-label="One model for every action"
                    data-testid="model-picker-global"
                    disabled={busy || state.pinnedByEnv}
                    value={state.selected ?? ""}
                    onChange={(event) => void choose(event.target.value || null)}
                  >
                    {/* First, and the default — nothing here has to be changed
                        for the routing to be the measured one. */}
                    <option value="">Per action (recommended)</option>
                    <ModelOptions models={state.models} />
                  </select>
                </label>
              </section>

              <section className="dash-sheet__section">
                <h3 className="dash-sheet__sub">Setting up — runs once</h3>
                {tiered("capable")}
              </section>

              <section className="dash-sheet__section">
                <h3 className="dash-sheet__sub">Using — runs constantly</h3>
                {tiered("fast")}
              </section>

              <p className="dash-models__total" data-testid="model-picker-spend">
                {state.spend.calls === 0
                  ? "No AI calls yet this server run."
                  : `${money(state.spend.usd)} across ${state.spend.calls} call${
                      state.spend.calls === 1 ? "" : "s"
                    } since this server started${
                      state.spend.unpriced > 0 ? `, ${state.spend.unpriced} unpriced` : ""
                    } · rates read ${state.ratesAsOf}`}
              </p>
            </div>
          </aside>
        </div>
      )}
    </>
  );
};
