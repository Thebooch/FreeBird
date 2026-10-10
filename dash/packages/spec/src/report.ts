import { z } from "zod";

/**
 * Timed reports: emailed on a schedule, built from blocks.
 *
 * The smallest piece is a **tracked value**: one number Dash records every
 * day, read from a connection and narrowed to one record or group ("open work
 * orders at 123 Main St"). A **report** is a stack of blocks: tracked values
 * over a window, single widgets, whole tabs (a tab is a stack of its widgets)
 * and short notes. Each report is written up in a few sentences by default.
 *
 * Its schedule is a cron expression read in the report's own time zone, the
 * way a workflow's schedule is. `cronForCadence` and `cadenceOfCron` turn the
 * everyday shapes (daily, weekdays, weekly, monthly at a time) into one and
 * back, so a form never has to show cron.
 */

export const REPORT_WINDOWS = ["7d", "30d", "90d", "12mo"] as const;
export type ReportWindow = (typeof REPORT_WINDOWS)[number];

export const REPORT_WINDOW_DAYS: Readonly<Record<ReportWindow, number>> = { "7d": 7, "30d": 30, "90d": 90, "12mo": 365 };

export const TRACKED_AGGREGATES = ["count", "sum", "avg", "min", "max", "latest"] as const;
export type TrackedAggregate = (typeof TRACKED_AGGREGATES)[number];

export const TRACKED_UNITS = ["number", "currency", "percent"] as const;
export type TrackedUnit = (typeof TRACKED_UNITS)[number];

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** One number for one record or group, kept day by day. */
export const trackedValueSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  source: z
    .object({
      connection: z.string().min(1),
      /** A record type, whose list is read… */
      record: z.string().min(1).optional(),
      /** …or an endpoint by its id. */
      op: z.string().min(1).optional(),
      params: z.record(z.string(), scalar).default({}),
      /** Rows whose fields equal these are kept: what pins it to one property or client. */
      filter: z.record(z.string(), z.union([scalar, z.null()])).default({}),
    })
    .refine((source) => Boolean(source.record || source.op), { message: "Say which record type or endpoint it reads." }),
  value: z
    .object({
      aggregate: z.enum(TRACKED_AGGREGATES),
      /** The field summed, averaged or read. Not needed to count. */
      field: z.string().min(1).max(200).optional(),
    })
    .refine((value) => value.aggregate === "count" || Boolean(value.field), { message: "Say which field to read." }),
  unit: z.enum(TRACKED_UNITS).default("number"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TrackedValue = z.infer<typeof trackedValueSchema>;

export const trackedValueInputSchema = trackedValueSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type TrackedValueInput = z.input<typeof trackedValueInputSchema>;

/**
 * What the reader cares about most, in their words ("Did a leak come up?"):
 * the summary for that block answers it first. Optional.
 */
const emphasisSchema = z.string().trim().max(500).optional();

/**
 * A report is read as parts. A whole tab is one part: one summary, then each
 * widget as a picture of its numbers. A widget picked on its own, or a
 * tracked value, is a part of its own: its summary, then its picture.
 */
export const reportBlockSchema = z.discriminatedUnion("kind", [
  /** A tracked value: where it is now, and how it moved over the window. */
  z.object({ kind: z.literal("value"), tracked: z.string().min(1), window: z.enum(REPORT_WINDOWS).default("30d"), emphasis: emphasisSchema }),
  /** One widget, as it reads at send time, with a summary of its own. */
  z.object({ kind: z.literal("widget"), dashboard: z.string().min(1), widget: z.string().min(1), emphasis: emphasisSchema }),
  /** A whole tab: one summary, then every widget on it in the order the tab shows them. */
  z.object({ kind: z.literal("tab"), dashboard: z.string().min(1), emphasis: emphasisSchema }),
  /** A note in the report's own words. */
  z.object({ kind: z.literal("text"), markdown: z.string().trim().min(1).max(4000) }),
]);
export type ReportBlock = z.infer<typeof reportBlockSchema>;

export const reportScheduleSchema = z.object({
  cron: z.string().trim().min(9).max(120),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
});
export type ReportSchedule = z.infer<typeof reportScheduleSchema>;

const emailSchema = z.string().trim().toLowerCase().email("That isn't an email address.").max(254);

export const REPORT_MAX_RECIPIENTS = 25;
export const REPORT_MAX_BLOCKS = 40;

export const reportSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  /** Whose name and colour the email wears. Optional. */
  agentId: z.string().min(1).optional(),
  /** Off: kept, not sent on its schedule. "Send now" still works. */
  enabled: z.boolean().default(true),
  schedule: reportScheduleSchema,
  recipients: z.array(emailSchema).min(1, "Add at least one email address.").max(REPORT_MAX_RECIPIENTS),
  /** Recipients who unsubscribed: never sent to again, whatever the list says. */
  optedOut: z.array(emailSchema).default([]),
  blocks: z.array(reportBlockSchema).min(1, "Pick what the report shows.").max(REPORT_MAX_BLOCKS),
  /** A few sentences written from the numbers, on top. Default on. */
  summary: z.enum(["auto", "none"]).default("auto"),
  createdBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** When it last went out to anyone. */
  lastSentAt: z.string().optional(),
  /** When it was last tried, sent or not: what its schedule counts from. */
  lastAttemptAt: z.string().optional(),
});
export type Report = z.infer<typeof reportSchema>;

/** What a person sets: everything but the bookkeeping. */
export const reportInputSchema = reportSchema.pick({
  name: true,
  agentId: true,
  enabled: true,
  schedule: true,
  recipients: true,
  blocks: true,
  summary: true,
});
export type ReportInput = z.input<typeof reportInputSchema>;

export const REPORT_SEND_STATUSES = ["sent", "partial", "failed"] as const;
export type ReportSendStatus = (typeof REPORT_SEND_STATUSES)[number];

export const REPORT_TRIGGERS = ["schedule", "manual", "workflow"] as const;
export type ReportTrigger = (typeof REPORT_TRIGGERS)[number];

/** One time a report went out, or tried to. */
export const reportSendSchema = z.object({
  id: z.string(),
  report: z.string(),
  reportName: z.string(),
  at: z.string(),
  status: z.enum(REPORT_SEND_STATUSES),
  trigger: z.enum(REPORT_TRIGGERS),
  /** Who it reached. */
  recipients: z.array(z.string()).default([]),
  /** Who it did not, and why. */
  failures: z.array(z.object({ to: z.string(), error: z.string() })).default([]),
  /** Why nothing went, when nothing did. */
  error: z.string().optional(),
  subject: z.string().optional(),
  agentId: z.string().optional(),
  /** The workflow step that sent it, so a retry finds this send instead of sending again. */
  key: z.string().optional(),
});
export type ReportSend = z.infer<typeof reportSendSchema>;

/** The tabs a report draws from: what lists it under each tab. */
export const reportDashboards = (report: Pick<Report, "blocks">): string[] => [
  ...new Set(report.blocks.flatMap((block) => (block.kind === "widget" || block.kind === "tab" ? [block.dashboard] : []))),
];

/* ── cadence ───────────────────────────────────────────────────────────── */

export const REPORT_EVERY = ["day", "weekday", "week", "month"] as const;
export type ReportEvery = (typeof REPORT_EVERY)[number];

/** The everyday shapes of a schedule. `time` is "HH:MM", 24-hour, in the report's zone. */
export interface ReportCadence {
  readonly every: ReportEvery;
  readonly time: string;
  /** 0 Sunday … 6 Saturday, for `week`. */
  readonly weekday?: number;
  /** 1 … 28, for `month`: every month has one. */
  readonly monthDay?: number;
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const timeParts = (time: string): { hour: number; minute: number } | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
};

/** The cron a cadence is. Throws on a time or day that is not one. */
export const cronForCadence = (cadence: ReportCadence): string => {
  const parts = timeParts(cadence.time);
  if (!parts) throw new Error(`"${cadence.time}" is not a time: use HH:MM.`);
  const at = `${parts.minute} ${parts.hour}`;
  switch (cadence.every) {
    case "day":
      return `${at} * * *`;
    case "weekday":
      return `${at} * * 1-5`;
    case "week": {
      const day = cadence.weekday ?? 1;
      if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error("Pick a day of the week.");
      return `${at} * * ${day}`;
    }
    case "month": {
      const day = cadence.monthDay ?? 1;
      if (!Number.isInteger(day) || day < 1 || day > 28) throw new Error("Pick a day from 1 to 28.");
      return `${at} ${day} * *`;
    }
  }
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** The cadence a cron is, when it is one of the everyday shapes; null for anything else. */
export const cadenceOfCron = (cron: string): ReportCadence | null => {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || month !== "*") return null;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (!timeParts(time)) return null;
  if (dom === "*" && dow === "*") return { every: "day", time };
  if (dom === "*" && dow === "1-5") return { every: "weekday", time };
  if (dom === "*" && /^[0-6]$/.test(dow)) return { every: "week", time, weekday: Number(dow) };
  if (/^\d{1,2}$/.test(dom) && dow === "*" && Number(dom) >= 1 && Number(dom) <= 28) return { every: "month", time, monthDay: Number(dom) };
  return null;
};

const ordinal = (day: number): string => {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`;
};

/** "Every Monday at 08:00", or the cron itself for a shape this cannot say. */
export const describeSchedule = (schedule: Pick<ReportSchedule, "cron">): string => {
  const cadence = cadenceOfCron(schedule.cron);
  if (!cadence) return `On the schedule ${schedule.cron}`;
  switch (cadence.every) {
    case "day":
      return `Every day at ${cadence.time}`;
    case "weekday":
      return `Weekdays at ${cadence.time}`;
    case "week":
      return `Every ${WEEKDAY_NAMES[cadence.weekday ?? 1]} at ${cadence.time}`;
    case "month":
      return `Monthly on the ${ordinal(cadence.monthDay ?? 1)} at ${cadence.time}`;
  }
};
