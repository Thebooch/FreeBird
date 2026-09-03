import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardSchema } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";
import {
  GrantStore,
  approveWidget,
  dashboardApprovals,
  evaluateWidget,
  widgetDeclaration,
  widgetGrantSubject,
} from "./grants.js";

let dir: string;
let store: SpecStore;
let grants: GrantStore;
let keys: KeyStore;

const board = (widgetOver: Record<string, unknown> = {}) =>
  dashboardSchema.parse({
    id: "ops",
    title: "Ops",
    widgets: [
      {
        id: "revenue",
        title: "Revenue",
        component: "timeseries",
        source: { connection: "stripe", op: "charges" },
        roles: { time: "created", value: "amount" },
        ...widgetOver,
      },
    ],
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-grants-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  grants = new GrantStore(join(dir, ".dash", "grants.json"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

describe("widget grants", () => {
  it("declares every connection and op a widget reads", () => {
    const single = board().widgets[0]!;
    expect(widgetDeclaration(single)).toEqual(["connection:stripe", "op:stripe/charges"]);
  });

  it("declares every source of a multi-source widget", () => {
    const multi = dashboardSchema.parse({
      id: "ops",
      title: "Ops",
      widgets: [
        {
          id: "joined",
          title: "Joined",
          component: "table",
          sources: [
            { as: "a", label: "Charges", connection: "stripe", op: "charges" },
            { as: "b", label: "Contacts", connection: "hubspot", op: "contacts" },
          ],
          combine: { op: "union" },
        },
      ],
    }).widgets[0]!;
    expect(widgetDeclaration(multi)).toEqual([
      "connection:stripe",
      "op:stripe/charges",
      "connection:hubspot",
      "op:hubspot/contacts",
    ]);
  });

  it("starts unapproved", () => {
    expect(evaluateWidget(grants, "ops", board().widgets[0]!).verdict).toBe("absent");
  });

  it("is valid once approved as saved", () => {
    const widget = board().widgets[0]!;
    approveWidget(grants, "ops", widget);
    expect(evaluateWidget(grants, "ops", widget).verdict).toBe("valid");
  });

  it("drops approval when the pipeline changes, not just the source", () => {
    const widget = board().widgets[0]!;
    approveWidget(grants, "ops", widget);
    const edited = board({ pipeline: [{ op: "filter", where: "amount > 0" }] }).widgets[0]!;
    expect(evaluateWidget(grants, "ops", edited).verdict).toBe("digest-changed");
  });

  it("drops approval when the widget points at a different endpoint", () => {
    approveWidget(grants, "ops", board().widgets[0]!);
    const moved = board({ source: { connection: "stripe", op: "payouts" } }).widgets[0]!;
    expect(evaluateWidget(grants, "ops", moved).verdict).toBe("digest-changed");
  });

  it("survives a process restart", () => {
    approveWidget(grants, "ops", board().widgets[0]!);
    const reopened = new GrantStore(join(dir, ".dash", "grants.json"));
    expect(evaluateWidget(reopened, "ops", board().widgets[0]!).verdict).toBe("valid");
  });

  it("fails closed when the grant file is unreadable", () => {
    const missing = new GrantStore(join(dir, ".dash", "nope", "grants.json"));
    expect(missing.read(widgetGrantSubject("ops", "revenue"))).toBeNull();
  });

  it("revokes every grant on a board when the board is deleted", () => {
    approveWidget(grants, "ops", board().widgets[0]!);
    grants.revokeDashboard("ops");
    expect(evaluateWidget(grants, "ops", board().widgets[0]!).verdict).toBe("absent");
  });

  it("reports approval state per widget in board order", () => {
    const dashboard = board();
    expect(dashboardApprovals(grants, dashboard)).toEqual([
      {
        widget: "revenue",
        verdict: "absent",
        added: [],
        declaration: ["connection:stripe", "op:stripe/charges"],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe("approval routes", () => {
  it("omits approvals entirely when the feature is not enabled", async () => {
    store.putDashboard(board());
    const app = buildServer({ store, keys });
    const res = await app.inject({ method: "GET", url: "/api/dashboards/ops" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("approvals");
  });

  it("returns the board with approval state when enabled", async () => {
    store.putDashboard(board());
    const app = buildServer({ store, keys, grants });
    const res = await app.inject({ method: "GET", url: "/api/dashboards/ops" });
    expect(res.json().approvals).toEqual([
      expect.objectContaining({ widget: "revenue", verdict: "absent" }),
    ]);
  });

  it("approves a widget as saved, then reports it valid", async () => {
    store.putDashboard(board());
    const app = buildServer({ store, keys, grants });

    const approved = await app.inject({
      method: "POST",
      url: "/api/dashboards/ops/widgets/revenue/approve",
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ subject: "widget:ops/revenue" });

    const res = await app.inject({ method: "GET", url: "/api/dashboards/ops" });
    expect(res.json().approvals[0].verdict).toBe("valid");
  });

  it("loses the approval when the saved board is edited afterwards", async () => {
    store.putDashboard(board());
    const app = buildServer({ store, keys, grants });
    await app.inject({ method: "POST", url: "/api/dashboards/ops/widgets/revenue/approve" });

    // The agent rewrites the widget after the human approved it.
    store.putDashboard(board({ pipeline: [{ op: "filter", where: "amount > 0" }] }));

    const res = await app.inject({ method: "GET", url: "/api/dashboards/ops" });
    expect(res.json().approvals[0].verdict).toBe("digest-changed");
  });

  it("revokes on request", async () => {
    store.putDashboard(board());
    const app = buildServer({ store, keys, grants });
    await app.inject({ method: "POST", url: "/api/dashboards/ops/widgets/revenue/approve" });
    await app.inject({
      method: "DELETE",
      url: "/api/dashboards/ops/widgets/revenue/approve",
    });
    const res = await app.inject({ method: "GET", url: "/api/dashboards/ops" });
    expect(res.json().approvals[0].verdict).toBe("absent");
  });

  it("404s approving a widget that is not on the board", async () => {
    store.putDashboard(board());
    const app = buildServer({ store, keys, grants });
    const res = await app.inject({
      method: "POST",
      url: "/api/dashboards/ops/widgets/ghost/approve",
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not carry a deleted board approval to its replacement", async () => {
    store.putDashboard(board());
    const app = buildServer({ store, keys, grants });
    await app.inject({ method: "POST", url: "/api/dashboards/ops/widgets/revenue/approve" });

    await app.inject({ method: "DELETE", url: "/api/dashboards/ops" });
    store.putDashboard(board());

    const res = await app.inject({ method: "GET", url: "/api/dashboards/ops" });
    expect(res.json().approvals[0].verdict).toBe("absent");
  });
});
