import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LlmTask, isTask } from "./models.js";

/**
 * Per-instance preferences that are chosen in the UI rather than configured on
 * disk — currently just which model runs which AI action.
 *
 * This lives beside the vault in `.dash/` rather than with the specs, because
 * it is a property of *this installation*, not of the dashboards. Specs are
 * meant to be committed and shared; a model choice is local and would only
 * create noise in a diff.
 */

export interface Settings {
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

const EMPTY: Settings = { model: null, models: {} };

/** Keep only string values under names that are still real tasks. */
const readTasks = (raw: unknown): Partial<Record<LlmTask, string>> => {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Record<LlmTask, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isTask(key) && typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
};

export class SettingsStore {
  constructor(private readonly path: string) {}

  read(): Settings {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Settings>;
      return {
        model: typeof parsed.model === "string" && parsed.model ? parsed.model : null,
        models: readTasks(parsed.models),
      };
    } catch {
      // Absent or corrupt both mean "nothing chosen" — a settings file is not
      // worth refusing to boot over.
      return EMPTY;
    }
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
