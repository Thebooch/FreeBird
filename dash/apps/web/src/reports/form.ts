import {
  cadenceOfCron,
  cronForCadence,
  type DashboardSpec,
  type Report,
  type ReportBlock,
  type ReportEvery,
  type ReportInput,
} from "@freebirdai/dash-spec";

/**
 * The Reports pop-up's form, and the report it stands for.
 *
 * The pop-up belongs to one tab, so the form only shows that tab: the whole
 * tab, or some of its widgets. Anything else a report holds (another tab's
 * widgets, a tracked value, a note: made elsewhere, by the chat or a later
 * screen) is kept as it is and saved back unchanged.
 */

export type ScheduleChoice = ReportEvery | "custom";

export interface ReportForm {
  readonly name: string;
  /** All of this tab, or the widgets picked. */
  readonly include: "tab" | "widgets";
  readonly widgets: readonly string[];
  /** What the reader wants to hear about, for the whole tab… */
  readonly tabEmphasis: string;
  /** …or for each widget picked, by its id. */
  readonly widgetEmphasis: Readonly<Record<string, string>>;
  readonly every: ScheduleChoice;
  /** "HH:MM", 24-hour, in `timezone`. */
  readonly time: string;
  /** 0 Sunday … 6 Saturday. */
  readonly weekday: number;
  /** 1 … 28. */
  readonly monthDay: number;
  /** A schedule the everyday choices cannot say, kept as written. */
  readonly cron: string;
  readonly timezone: string;
  /** Addresses, separated by commas, spaces or new lines. */
  readonly recipients: string;
  readonly summary: boolean;
  readonly agentId: string;
  readonly enabled: boolean;
  /** Blocks that are not this tab's, kept as they were. */
  readonly kept: readonly ReportBlock[];
}

export const localZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const thisTab = (block: ReportBlock, dashboard: string): boolean => (block.kind === "tab" || block.kind === "widget") && block.dashboard === dashboard;

/** A fresh form for a tab, or the form a saved report fills in. */
export const formOf = (dashboard: DashboardSpec, report?: Report, zone: string = localZone()): ReportForm => {
  if (!report) {
    return {
      name: `${dashboard.title} report`,
      include: "tab",
      widgets: [],
      tabEmphasis: "",
      widgetEmphasis: {},
      every: "week",
      time: "08:00",
      weekday: 1,
      monthDay: 1,
      cron: "",
      timezone: zone,
      recipients: "",
      summary: true,
      agentId: "",
      enabled: true,
      kept: [],
    };
  }
  const mine = report.blocks.filter((block) => thisTab(block, dashboard.id));
  const cadence = cadenceOfCron(report.schedule.cron);
  return {
    name: report.name,
    include: mine.some((block) => block.kind === "tab") || mine.length === 0 ? "tab" : "widgets",
    widgets: mine.flatMap((block) => (block.kind === "widget" ? [block.widget] : [])),
    tabEmphasis: mine.find((block) => block.kind === "tab")?.emphasis ?? "",
    widgetEmphasis: Object.fromEntries(mine.flatMap((block) => (block.kind === "widget" && block.emphasis ? [[block.widget, block.emphasis]] : []))),
    every: cadence?.every ?? "custom",
    time: cadence?.time ?? "08:00",
    weekday: cadence?.weekday ?? 1,
    monthDay: cadence?.monthDay ?? 1,
    cron: cadence ? "" : report.schedule.cron,
    timezone: report.schedule.timezone,
    recipients: report.recipients.join(", "),
    summary: report.summary !== "none",
    agentId: report.agentId ?? "",
    enabled: report.enabled,
    kept: report.blocks.filter((block) => !thisTab(block, dashboard.id)),
  };
};

/** Addresses as typed: split on commas, semicolons, spaces and new lines, each once. */
export const splitRecipients = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,;]+/)
      .map((one) => one.trim().toLowerCase())
      .filter(Boolean),
  ),
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The report a form says, or what is missing. */
export const inputOf = (form: ReportForm, dashboard: DashboardSpec): { ok: true; input: ReportInput } | { ok: false; error: string } => {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Give the report a name." };
  const recipients = splitRecipients(form.recipients);
  if (recipients.length === 0) return { ok: false, error: "Add at least one email address." };
  const bad = recipients.find((one) => !EMAIL.test(one));
  if (bad) return { ok: false, error: `"${bad}" isn't an email address.` };

  const picked = dashboard.widgets.filter((widget) => form.widgets.includes(widget.id));
  if (form.include === "widgets" && picked.length === 0) return { ok: false, error: "Pick at least one widget, or send the whole tab." };
  /* What to emphasize only steers a summary: with summaries off there is nothing for it to steer. */
  const emphasis = (text: string | undefined) => (form.summary && text?.trim() ? { emphasis: text.trim() } : {});
  const mine: ReportBlock[] =
    form.include === "tab"
      ? [{ kind: "tab", dashboard: dashboard.id, ...emphasis(form.tabEmphasis) }]
      : picked.map((widget) => ({ kind: "widget", dashboard: dashboard.id, widget: widget.id, ...emphasis(form.widgetEmphasis[widget.id]) }));

  let cron: string;
  if (form.every === "custom") {
    cron = form.cron.trim();
    if (!cron) return { ok: false, error: "Write the schedule, or pick one of the others." };
  } else {
    try {
      cron = cronForCadence({ every: form.every, time: form.time, weekday: form.weekday, monthDay: form.monthDay });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    ok: true,
    input: {
      name,
      enabled: form.enabled,
      schedule: { cron, timezone: form.timezone },
      recipients,
      blocks: [...mine, ...form.kept],
      summary: form.summary ? "auto" : "none",
      ...(form.agentId ? { agentId: form.agentId } : {}),
    },
  };
};

/** What a report sends from a tab, in a few words: "Whole tab", "3 widgets". */
export const includesLine = (report: Pick<Report, "blocks">, dashboard: DashboardSpec): string => {
  const mine = report.blocks.filter((block) => thisTab(block, dashboard.id));
  const others = report.blocks.length - mine.length;
  const here = mine.some((block) => block.kind === "tab")
    ? "Whole tab"
    : mine.length === 1 && mine[0]?.kind === "widget"
      ? (dashboard.widgets.find((widget) => widget.id === (mine[0] as { widget: string }).widget)?.title ?? "1 widget")
      : `${mine.length} widgets`;
  return others > 0 ? `${here}, and ${others} more ${others === 1 ? "piece" : "pieces"}` : here;
};
