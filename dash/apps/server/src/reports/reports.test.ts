import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmailAdapter, EmailMessage } from "@freebirdai/core";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import { fakeLlm } from "@freebirdai/dash-agent";
import {
  cadenceOfCron,
  cronForCadence,
  dashboardSchema,
  describeSchedule,
  type DashboardSpec,
  type Principal,
  type ReportInput,
  type TrackedValue,
} from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySnapshotStore } from "../history/store.js";
import { MemoryMembershipStore } from "../identity/members.js";
import { rolePolicy } from "../identity/policy.js";
import { openDashDb } from "../platform/db.js";
import { MemoryPublicTokenStore } from "../public/tokens.js";
import { buildServer } from "../server.js";
import { SpecStore } from "../store.js";
import { TRACKED_DASHBOARD } from "./build.js";
import { aggregateRows, type TrackedReader, type WidgetReader, type WidgetReading } from "./read.js";
import { ReportError, ReportService } from "./service.js";
import { DbReportStore, MemoryReportStore, type ReportStore } from "./store.js";

/*
 * Timed reports: built from what each widget shows, written up, emailed to
 * each recipient on its own, on a schedule read in the report's zone.
 */

const board: DashboardSpec = dashboardSchema.parse({
  id: "props",
  title: "Properties",
  widgets: [
    { id: "units", title: "Vacant units", component: "table", source: { connection: "pm", op: "units" }, roles: {} },
    { id: "vacant", title: "Vacancies", component: "stat", source: { connection: "pm", op: "units" }, roles: { value: "value" } },
  ],
  /* Vacancies sits above the table, so a whole-tab report shows it first. */
  layout: {
    cells: [
      { widgetId: "units", x: 0, y: 2, w: 6, h: 4 },
      { widgetId: "vacant", x: 0, y: 0, w: 3, h: 2 },
    ],
  },
});

class RecordingEmail implements EmailAdapter {
  readonly defaultFrom = "reports@acme.test";
  readonly sent: EmailMessage[] = [];
  failFor = new Set<string>();
  async send(message: EmailMessage): Promise<{ id: string }> {
    if (this.failFor.has(String(message.to))) throw new Error("mailbox full");
    this.sent.push(message);
    return { id: String(this.sent.length) };
  }
}

const readWidget: WidgetReader = async (_dashboard, widget): Promise<WidgetReading> =>
  (widget.id === "vacant"
    ? { rows: [{ value: 3 }], columns: [{ name: "value" }], warnings: [] }
    : {
        rows: [
          { unit: "1A", rent: 1200 },
          { unit: "2B", rent: 1350 },
        ],
        columns: [{ name: "unit" }, { name: "rent" }],
        warnings: [],
      }) as unknown as WidgetReading; // columns carry only their names here

const NOW = Date.UTC(2026, 9, 12, 12); // Monday 12 Oct 2026, 07:00 in Chicago
const principal: Principal = { userId: "sam", workspaceId: "acme", role: "owner", kind: "member" };

const setup = (over: { email?: RecordingEmail | null; store?: ReportStore; llm?: ReturnType<typeof fakeLlm> | null; readTracked?: TrackedReader } = {}) => {
  const clock = { now: NOW };
  let ids = 0;
  const email = over.email === undefined ? new RecordingEmail() : over.email;
  const store = over.store ?? new MemoryReportStore();
  const snapshots = new MemorySnapshotStore();
  const tokens = new MemoryPublicTokenStore();
  const llm = over.llm === undefined ? fakeLlm([{ text: "Vacancies are at **3**, up from 2." }, { text: "Still 3." }, { text: "Again." }]) : over.llm;
  const service = new ReportService({
    store,
    snapshots,
    dashboards: () => [board],
    hasConnection: (id) => id === "pm",
    readWidget,
    readTracked: over.readTracked ?? (async () => ({ value: 7, complete: true })),
    email,
    llm: () => llm,
    agent: async (id) => (id === "ava" ? ({ id: "ava", name: "Ava", color: 3 } as never) : null),
    tokens,
    brand: async () => ({ name: "Acme", accent: "#2f5bea" }),
    workspace: "acme",
    origin: "https://dash.acme.test",
    now: () => clock.now,
    newId: () => `id-${++ids}`,
  });
  /* Null only when a test asked for no email; those tests never read it. */
  return { service, store, snapshots, email: email as RecordingEmail, clock, llm };
};

const weekly: ReportInput = {
  name: "Monday properties",
  schedule: { cron: "0 8 * * 1", timezone: "America/Chicago" },
  recipients: ["Pat@Acme.test", "lee@acme.test"],
  blocks: [{ kind: "tab", dashboard: "props" }],
};

describe("report schedules", () => {
  it("turn everyday cadences into cron and back", () => {
    for (const cadence of [
      { every: "day", time: "07:30" },
      { every: "weekday", time: "08:00" },
      { every: "week", time: "16:45", weekday: 5 },
      { every: "month", time: "09:00", monthDay: 1 },
    ] as const) {
      expect(cadenceOfCron(cronForCadence(cadence))).toEqual(cadence);
    }
    expect(describeSchedule({ cron: "0 8 * * 1" })).toBe("Every Monday at 08:00");
    expect(describeSchedule({ cron: "0 9 2 * *" })).toBe("Monthly on the 2nd at 09:00");
    expect(cadenceOfCron("*/5 * * * *")).toBeNull();
    expect(() => cronForCadence({ every: "month", time: "09:00", monthDay: 31 })).toThrow();
  });
});

describe("making a report", () => {
  it("checks what it names, and keeps addresses in one spelling", async () => {
    const { service } = setup();
    const made = await service.create(principal, weekly);
    expect(made.recipients).toEqual(["pat@acme.test", "lee@acme.test"]);
    expect(made.enabled).toBe(true);
    expect(made.summary).toBe("auto");

    await expect(service.create(principal, { ...weekly, blocks: [{ kind: "tab", dashboard: "nope" }] })).rejects.toThrow(/no tab "nope"/);
    await expect(service.create(principal, { ...weekly, blocks: [{ kind: "widget", dashboard: "props", widget: "gone" }] })).rejects.toThrow(/no widget/);
    await expect(service.create(principal, { ...weekly, recipients: ["not an address"] })).rejects.toThrow(/email address/);
    await expect(service.create(principal, { ...weekly, schedule: { cron: "61 8 * * 1", timezone: "UTC" } })).rejects.toThrow(/schedule/);
    await expect(service.create(principal, { ...weekly, schedule: { cron: "0 8 * * 1", timezone: "Mars/Olympus" } })).rejects.toThrow(/time zone/);
    await expect(service.create(principal, { ...weekly, blocks: [{ kind: "value", tracked: "x", window: "30d" }] })).rejects.toThrow(/tracked value/);
  });

  it("lists the reports that draw from a tab", async () => {
    const { service } = setup();
    await service.create(principal, weekly);
    await service.create(principal, { ...weekly, name: "Just notes", blocks: [{ kind: "text", markdown: "Hello" }] });
    expect((await service.list("props")).map((one) => one.name)).toEqual(["Monday properties"]);
    expect(await service.list()).toHaveLength(2);
  });
});

describe("building a report", () => {
  it("shows a whole tab in its order, the number tile's change, and a summary on top", async () => {
    const { service, snapshots } = setup();
    await snapshots.record("props", "vacant", { day: "2026-10-05", value: 2 });
    const preview = await service.preview(weekly);
    expect(preview.subject).toBe("Monday properties · Monday, October 12, 2026");
    expect(preview.html.indexOf("Vacancies")).toBeLessThan(preview.html.indexOf("Vacant units"));
    expect(preview.html).toContain("Vacancies are at <strong>3</strong>, up from 2.");
    expect(preview.text).toContain("Vacancies: 3 (+1 (+50%) since Oct 5)");
    expect(preview.text).toContain("1A | 1200");
    expect(preview.text).toContain("Every Monday at 08:00 (America/Chicago)");
    expect(preview.html).toContain("https://dash.acme.test/#/d/props");
  });

  it("goes without a summary when the model fails, and says so in the preview", async () => {
    const llm = { generate: async () => Promise.reject(new Error("model down")) } as unknown as ReturnType<typeof fakeLlm>;
    const { service } = setup({ llm });
    const preview = await service.preview(weekly);
    expect(preview.warnings.join(" ")).toMatch(/summary could not be written/);
    expect(preview.html).toContain("Vacant units");
  });

  it("reads a widget once, even when the tab it is on is in the report too", async () => {
    let reads = 0;
    const { service } = setup();
    (service as unknown as { deps: { readWidget: WidgetReader } }).deps = {
      ...(service as unknown as { deps: object }).deps,
      readWidget: async (dashboard: Parameters<WidgetReader>[0], widget: Parameters<WidgetReader>[1]) => {
        reads += 1;
        return readWidget(dashboard, widget);
      },
    } as never;
    await service.preview({ ...weekly, summary: "none", blocks: [{ kind: "widget", dashboard: "props", widget: "units" }, { kind: "tab", dashboard: "props" }] });
    expect(reads).toBe(2);
  });
});

describe("sending a report", () => {
  it("emails each recipient their own copy, logs it, and remembers when", async () => {
    const { service, email, store } = setup();
    const report = await service.create(principal, { ...weekly, agentId: "ava" });
    const send = await service.send(report.id, "manual");
    expect(send.status).toBe("sent");
    expect(send.recipients).toEqual(["pat@acme.test", "lee@acme.test"]);
    expect(email.sent.map((one) => one.to)).toEqual(["pat@acme.test", "lee@acme.test"]);
    expect(email.sent[0]?.from).toBe('"Ava" <reports@acme.test>');
    const links = email.sent.map((one) => /Unsubscribe: (\S+)/.exec(one.text)?.[1]);
    expect(links[0]).toMatch(/^https:\/\/dash\.acme\.test\/api\/public\/acme\/reports\/unsubscribe\//);
    expect(links[0]).not.toBe(links[1]);
    expect((await store.get(report.id))?.lastSentAt).toBe(new Date(NOW).toISOString());
    expect(await service.sends(report.id)).toHaveLength(1);
  });

  it("says why when email is not set up, and logs the attempt", async () => {
    const { service } = setup({ email: null });
    const report = await service.create(principal, weekly);
    expect(service.emailStatus().ready).toBe(false);
    const send = await service.send(report.id, "manual");
    expect(send.status).toBe("failed");
    expect(send.error).toMatch(/DASH_EMAIL/);
  });

  it("is partial when one address fails", async () => {
    const { service, email } = setup();
    email.failFor.add("lee@acme.test");
    const report = await service.create(principal, weekly);
    const send = await service.send(report.id, "manual");
    expect(send.status).toBe("partial");
    expect(send.failures).toEqual([{ to: "lee@acme.test", error: "mailbox full" }]);
  });

  it("sends once for a workflow step, however often the step is tried", async () => {
    const { service, email } = setup();
    const report = await service.create(principal, weekly);
    const first = await service.send(report.id, "workflow", "attempt-1");
    const again = await service.send(report.id, "workflow", "attempt-1");
    expect(again.id).toBe(first.id);
    expect(email.sent).toHaveLength(2);
  });

  it("never sends again to someone who unsubscribed", async () => {
    const { service, email } = setup();
    const report = await service.create(principal, weekly);
    await service.send(report.id, "manual");
    const token = /unsubscribe\/(\S+)/.exec(email.sent[0]!.text)![1]!;
    expect(await service.unsubscribeTarget(token)).toEqual({ report: "Monday properties", email: "pat@acme.test", done: false });
    await service.unsubscribe(token);
    await service.unsubscribe(token);
    expect((await service.get(report.id)).optedOut).toEqual(["pat@acme.test"]);
    email.sent.length = 0;
    await service.send(report.id, "manual");
    expect(email.sent.map((one) => one.to)).toEqual(["lee@acme.test"]);
    await expect(service.unsubscribe("x".repeat(43))).rejects.toBeInstanceOf(ReportError);
  });
});

describe("the schedule", () => {
  it("sends when its time comes in its own zone, once, and not while it is off", async () => {
    const { service, email, clock } = setup({ llm: null });
    const report = await service.create(principal, weekly);
    expect(await service.runDue()).toBe(0); // 07:00 in Chicago
    clock.now = NOW + 60 * 60_000; // 08:00
    expect(await service.runDue()).toBe(1);
    expect(await service.runDue()).toBe(0);
    expect(email.sent).toHaveLength(2);

    await service.update(report.id, { enabled: false });
    clock.now = NOW + 7 * 86_400_000 + 60 * 60_000;
    expect(await service.runDue()).toBe(0);
  });

  it("is taken by one server when two share a database", async () => {
    const store = new MemoryReportStore();
    const one = setup({ store, llm: null });
    const two = setup({ store, llm: null });
    await one.service.create(principal, weekly);
    one.clock.now = two.clock.now = NOW + 60 * 60_000;
    const [a, b] = await Promise.all([one.service.runDue(), two.service.runDue()]);
    expect(a + b).toBe(1);
  });

  it("does not send a missed turn of a schedule that was just changed", async () => {
    const { service, clock } = setup({ llm: null });
    const report = await service.create(principal, weekly);
    clock.now = NOW + 2 * 60 * 60_000; // past 08:00
    await service.update(report.id, { schedule: { cron: "0 8 * * *", timezone: "America/Chicago" } });
    expect(await service.runDue()).toBe(0);
  });
});

describe("tracked values", () => {
  const vacancy = {
    name: "Open work orders at 123 Main",
    source: { connection: "pm", record: "work_order", filter: { property: "123 Main", status: "open" } },
    value: { aggregate: "count" },
  };

  it("work out one number from rows", () => {
    const rows = [{ rent: 100 }, { rent: "200" }, { rent: null }];
    expect(aggregateRows(rows, { aggregate: "count" })).toBe(3);
    expect(aggregateRows(rows, { aggregate: "sum", field: "rent" })).toBe(300);
    expect(aggregateRows(rows, { aggregate: "avg", field: "rent" })).toBe(150);
    expect(aggregateRows(rows, { aggregate: "max", field: "rent" })).toBe(200);
    expect(aggregateRows([], { aggregate: "min", field: "rent" })).toBeNull();
  });

  it("are kept once a day from the day they are tracked, and shown with their change", async () => {
    let value = 4;
    const { service, snapshots, clock } = setup({ llm: null, readTracked: async () => ({ value, complete: true }) });
    const tracked: TrackedValue = await service.createTracked(vacancy);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await snapshots.list(TRACKED_DASHBOARD, tracked.id)).toEqual([{ day: "2026-10-12", value: 4 }]);

    value = 6;
    expect(await service.recordDue()).toBe(0); // already kept today
    clock.now = NOW + 86_400_000 + 2 * 60 * 60_000;
    expect(await service.recordDue()).toBe(1);
    expect((await service.trackedHistory(tracked.id)).since).toBe("2026-10-12");

    const preview = await service.preview({ ...weekly, summary: "none", blocks: [{ kind: "value", tracked: tracked.id, window: "7d" }] });
    expect(preview.text).toContain("Open work orders at 123 Main: 6 (+2 (+50%) since Oct 12)");

    const report = await service.create(principal, { ...weekly, blocks: [{ kind: "value", tracked: tracked.id, window: "7d" }] });
    await expect(service.removeTracked(tracked.id)).rejects.toThrow(/still shows/);
    await service.remove(report.id);
    await service.removeTracked(tracked.id);
    expect(await snapshots.list(TRACKED_DASHBOARD, tracked.id)).toEqual([]);
  });

  it("keep nothing from a read that did not reach every record", async () => {
    const { service, snapshots } = setup({ llm: null, readTracked: async () => ({ value: 2, complete: false }) });
    const tracked = await service.createTracked(vacancy);
    expect(await service.recordOne(tracked)).toBe(false);
    expect(await snapshots.list(TRACKED_DASHBOARD, tracked.id)).toEqual([]);
  });

  it("must read a connection that exists, and say what to read", async () => {
    const { service } = setup();
    await expect(service.createTracked({ ...vacancy, source: { connection: "other", record: "x" } })).rejects.toThrow(/no connection/);
    await expect(service.createTracked({ ...vacancy, value: { aggregate: "sum" } })).rejects.toThrow(/which field/);
  });
});

describe("the database report store", () => {
  it("keeps reports, takes turns one at a time, and logs sends newest first", async () => {
    const db = await openDashDb({ inMemory: true });
    try {
      const store = new DbReportStore(db, "acme");
      const { service } = setup({ store, llm: null });
      const report = await service.create(principal, weekly);
      expect((await store.list()).map((one) => one.id)).toEqual([report.id]);
      expect(await store.claim(report.id, null, "2026-10-12T13:00:00.000Z")).toBe(true);
      expect(await store.claim(report.id, null, "2026-10-12T13:00:00.000Z")).toBe(false);
      expect((await store.get(report.id))?.lastAttemptAt).toBe("2026-10-12T13:00:00.000Z");
      await service.send(report.id, "manual");
      await service.send(report.id, "manual");
      expect(await store.sends({ report: report.id })).toHaveLength(2);
      await store.putTracked({ id: "t1", name: "x", source: { connection: "pm", record: "unit", params: {}, filter: {} }, value: { aggregate: "count" }, unit: "number", createdAt: "a", updatedAt: "a" });
      expect((await store.listTracked()).map((one) => one.id)).toEqual(["t1"]);
      await store.delete(report.id);
      expect(await store.sends({ report: report.id })).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("report routes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dash-reports-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("are changed only with boards.edit, and unsubscribe from the email's link with nobody signed in", async () => {
    const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    store.putDashboard(board);
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
    const memberships = new MemoryMembershipStore();
    const member = (userId: string, role: Principal["role"]) => ({ workspaceId: "acme", userId, email: `${userId}@acme.test`, role, grants: [], joinedAt: "2026-10-06T00:00:00.000Z" });
    await memberships.putMember(member("ed", "editor"));
    await memberships.putMember(member("vi", "viewer"));
    const reports = new MemoryReportStore();
    const email = new RecordingEmail();
    const as = (userId: string, role: Principal["role"]) => ({ resolve: () => ({ userId, workspaceId: "acme", role, kind: "member" as const }) });
    /* Two servers over the same stores, as two people would reach one. */
    const common = { store, keys, reports, email, tokens: new MemoryPublicTokenStore(), policy: rolePolicy(memberships), workspace: { id: "acme", key: "acme" }, pagesOrigin: "https://dash.acme.test" };

    const viewer = buildServer({ ...common, identity: as("vi", "viewer") });
    const refused = await viewer.inject({ method: "POST", url: "/api/reports", payload: weekly });
    expect(refused.statusCode).toBe(403);

    const editor = buildServer({ ...common, identity: as("ed", "editor") });
    const made = await editor.inject({ method: "POST", url: "/api/reports", payload: weekly });
    expect(made.statusCode).toBe(200);
    const id = made.json().id as string;
    const listed = await viewer.inject({ method: "GET", url: "/api/reports?dashboard=props" });
    expect(listed.json().reports.map((one: { id: string }) => one.id)).toEqual([id]);
    expect(listed.json().email).toEqual({ ready: true });
    expect(listed.json().reports[0].nextAt).toBeTruthy();

    const sent = await editor.inject({ method: "POST", url: `/api/reports/${id}/send` });
    expect(sent.json().status).toBe("sent");
    /* The widgets read a connection that does not exist: each says so in its place, and the email still goes. */
    expect(email.sent[0]?.text).toContain("Could not be read");

    const path = new URL(/Unsubscribe: (\S+)/.exec(email.sent[0]!.text)![1]!).pathname;
    const page = await viewer.inject({ method: "GET", url: path });
    expect(page.body).toContain("Unsubscribe?");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Unsubscribe?");
    const done = await viewer.inject({ method: "POST", url: path });
    expect(done.body).toContain("unsubscribed");
    expect((await editor.inject({ method: "GET", url: `/api/reports/${id}` })).json().optedOut).toEqual(["pat@acme.test"]);
    expect((await viewer.inject({ method: "GET", url: path.replace("/acme/", "/other/") })).statusCode).toBe(404);
  });
});

describe("the mailer", () => {
  it("is set up from DASH_EMAIL, or says what is missing", async () => {
    const { mailerFromEnv } = await import("./mailer.js");
    expect(mailerFromEnv({})).toEqual({ email: null });
    expect(mailerFromEnv({ DASH_EMAIL: "smtp" }).problem).toMatch(/DASH_EMAIL_FROM/);
    expect(mailerFromEnv({ DASH_EMAIL: "resend", DASH_EMAIL_FROM: "r@acme.test" }).problem).toMatch(/RESEND_API_KEY/);
    expect(mailerFromEnv({ DASH_EMAIL: "pigeon", DASH_EMAIL_FROM: "r@acme.test" }).problem).toMatch(/resend or smtp/);
    expect(mailerFromEnv({ DASH_EMAIL: "smtp", DASH_EMAIL_FROM: "r@acme.test", DASH_SMTP_URL: "smtp://localhost:1025" }).email?.defaultFrom).toBe("r@acme.test");
  });
});
