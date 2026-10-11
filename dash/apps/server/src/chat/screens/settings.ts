import type { ActionDefinition, ComponentDefinition } from "@freebirdai/core";
import { DEFAULT_SETTINGS, LAYER_KEYS, resolveSettings, type SchedulingSettings } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { SchedulingOverview, SchedulingService } from "../../scheduling/service.js";
import { SCREENS, allowedTo, argsOf, landed, screenComponent, type ScreenAccess } from "./common.js";
import { mergedSettings, settingWords, settingsChanges, settingsInherit, settingsRows, SETTING_LABELS } from "./settings-words.js";

/**
 * Scheduling settings (`#/agent/calendar/settings`): the workspace's
 * defaults, the layer every booking starts from before a host, a type or a
 * block says otherwise. The buffer is set here or on a block only.
 */

export interface SettingsDeps extends ScreenAccess {
  readonly setup: SchedulingOverview;
  readonly scheduling: SchedulingService;
}

const SCREEN = SCREENS.settings;

const defaultsChange = z.object({ ...settingsChanges("workspace").shape, inherit: settingsInherit("workspace") });
type DefaultsChange = z.infer<typeof defaultsChange>;

export const settingsScreen = (deps: SettingsDeps): ComponentDefinition => {
  const { setup, scheduling } = deps;

  const read: ActionDefinition<Record<string, never>, unknown, unknown> = {
    id: "read_scheduling_defaults",
    description: "Read the workspace's scheduling defaults, each with whether the workspace sets it or it is the built-in default.",
    schema: z.object({}),
    requiresConfirmation: "none",
    mcp: { expose: false },
    handler: async () => {
      const { defaults } = await scheduling.overview();
      const { settings, from } = resolveSettings([{ layer: "workspace", settings: defaults }]);
      return {
        settings: (Object.keys(SETTING_LABELS) as Array<keyof SchedulingSettings>).map((key) => ({
          key,
          label: SETTING_LABELS[key],
          value: settingWords(key)((settings as Record<string, unknown>)[key] ?? null),
          from: from[key] === "workspace" ? "set for the workspace" : "built-in default",
        })),
      };
    },
  };

  const change: ActionDefinition<DefaultsChange, unknown, unknown> = {
    id: "change_scheduling_defaults",
    description:
      "Change the workspace's scheduling defaults (buffer, length, notice, horizon, approval, holds, cut-offs, stacking, grouping, showing the host): what every type and host follows unless it says otherwise. Shown on a card first.",
    schema: argsOf<DefaultsChange>(defaultsChange),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: allowedTo(deps, "calendar.manage", "Your role here does not allow changing scheduling."),
    preview: (args) => {
      const next = mergedSettings(setup.defaults, args, args.inherit);
      const rows = settingsRows(setup.defaults, next).map((row) => (row.value.endsWith("→ follows the level above") ? { ...row, value: row.value.replace("follows the level above", `the built-in default (${settingWords(keyOf(row.label))((DEFAULT_SETTINGS as Record<string, unknown>)[keyOf(row.label)] ?? null)})`) } : row));
      return { title: "Change the scheduling defaults", summary: rows.length > 0 ? "Every type and host follows these unless it says otherwise." : "Nothing would change.", rows };
    },
    handler: async (args) => {
      const { defaults } = await scheduling.overview();
      const next = mergedSettings(defaults, args, args.inherit);
      const rows = settingsRows(defaults, next);
      await scheduling.setDefaults(next);
      deps.changed();
      return landed({ saved: true }, SCREEN, { title: "Scheduling settings", summary: `Changed the scheduling defaults. ${rows.map((row) => `${row.label}: ${row.value}`).join("; ")}`.slice(0, 400) });
    },
  };

  const set = Object.entries(setup.defaults).filter(([, value]) => value !== undefined);
  return screenComponent(
    SCREEN,
    [`SCHEDULING DEFAULTS set for the workspace: ${set.length > 0 ? set.map(([key, value]) => `${key} ${settingWords(key as keyof SchedulingSettings)(value)}`).join("; ") : "none, so the built-in defaults apply"}. Settings each level may set: ${Object.entries(LAYER_KEYS).map(([layer, keys]) => `${layer}: ${keys.join(", ")}`).join(" | ")}.`],
    [read, change],
  );
};

const keyOf = (label: string): keyof SchedulingSettings => (Object.entries(SETTING_LABELS).find(([, words]) => words === label)?.[0] ?? "length") as keyof SchedulingSettings;
