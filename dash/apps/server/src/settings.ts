import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LlmTask, type Provider, isProvider, isTask, providerFor } from "./models.js";

/**
 * Per-instance preferences that are chosen in the UI rather than configured on
 * disk — currently which provider to run on, and which model runs which AI
 * action.
 *
 * This lives beside the vault in `.dash/` rather than with the specs, because
 * it is a property of *this installation*, not of the dashboards. Specs are
 * meant to be committed and shared; a model choice is local and would only
 * create noise in a diff.
 */

export interface Settings {
  /**
   * Whose models to run, when nothing more specific has said.
   *
   * The choice most people actually want to make — "run this on OpenAI for a
   * while" — sitting one level above the per-task table, which follows it.
   * Null means the built-in default provider applies.
   */
  readonly provider: Provider | null;
  /**
   * "Use this one model for everything", overriding the per-task defaults.
   *
   * Null means the defaults apply. This key predates per-task selection and
   * kept its name deliberately: an existing `settings.json` written when it
   * meant "the model" still parses, and still does what its author intended.
   */
  readonly model: string | null;
  /**
   * A model chosen for one task. Absent keys fall back — see `modelForTask`.
   *
   * Partial rather than complete on purpose: a stored answer for every task
   * would freeze today's defaults into every installation, so upgrading the
   * table below would silently change nothing for anyone who had ever opened
   * the picker.
   */
  readonly models: Partial<Record<LlmTask, string>>;
}

const EMPTY: Settings = { provider: null, model: null, models: {} };

/** Keep only string values under names that are still real tasks. */
const readTasks = (raw: unknown): Partial<Record<LlmTask, string>> => {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Record<LlmTask, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isTask(key) && typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
};

/** What a provider switch leaves behind: the choices it had to drop. */
export interface ProviderChange {
  readonly settings: Settings;
  /** Tasks whose pinned model belonged to the provider being left. */
  readonly clearedTasks: LlmTask[];
  /** True when the "one model for everything" choice was dropped too. */
  readonly clearedGlobal: boolean;
}

export class SettingsStore {
  constructor(private readonly path: string) {}

  read(): Settings {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Settings>;
      return {
        provider: isProvider(parsed.provider) ? parsed.provider : null,
        model: typeof parsed.model === "string" && parsed.model ? parsed.model : null,
        models: readTasks(parsed.models),
      };
    } catch {
      // Absent or corrupt both mean "nothing chosen" — a settings file is not
      // worth refusing to boot over.
      return EMPTY;
    }
  }

  /**
   * Choose whose models to run, or pass null to go back to the default.
   *
   * Switching provider *drops the choices that contradict it*. A row pinned to
   * Claude Opus while the provider says OpenAI is not a preference being
   * preserved, it is a switch that silently did not happen — and the one thing
   * worse than losing a pin is being told the provider changed when a third of
   * the actions still route to the old one. What was dropped is returned so it
   * can be said out loud rather than discovered later in a bill.
   */
  setProvider(provider: Provider | null): ProviderChange {
    const current = this.read();
    const stale = (model: string | undefined | null): boolean =>
      Boolean(provider && model && providerFor(model) !== provider);

    const models = { ...current.models };
    const clearedTasks: LlmTask[] = [];
    for (const [task, model] of Object.entries(models) as [LlmTask, string][]) {
      if (stale(model)) {
        delete models[task];
        clearedTasks.push(task);
      }
    }
    const clearedGlobal = stale(current.model);

    return {
      settings: this.write({
        provider,
        model: clearedGlobal ? null : current.model,
        models,
      }),
      clearedTasks,
      clearedGlobal,
    };
  }

  /** Pass null to clear the choice and go back to the per-task defaults. */
  setModel(model: string | null): Settings {
    const current = this.read();
    return this.write({ ...current, model: model && model.trim() ? model.trim() : null });
  }

  /**
   * Choose a model for one task, or pass null to go back to its default.
   *
   * Clearing *deletes* the key rather than storing null, so "no choice" is one
   * state on disk instead of two that read the same.
   */
  setTaskModel(task: LlmTask, model: string | null): Settings {
    const current = this.read();
    const models = { ...current.models };
    if (model && model.trim()) models[task] = model.trim();
    else delete models[task];
    return this.write({ ...current, models });
  }

  private write(next: Settings): Settings {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }
}
