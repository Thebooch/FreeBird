import type { AuthoredWidget } from "@freebirdai/dash-agent";
import { type DashboardSpec, dashboardSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { type BuildChatRegistryInput, buildChatRegistry } from "./registry.js";

/**
 * What the assistant is told, and what it is allowed to do about it.
 *
 * These assert the two failures this layer exists to prevent: an assistant
 * that can act on something it cannot name, and one that accepts an id nobody
 * ever showed it.
 */

const board = (id: string, title: string, widgets: unknown[] = []): DashboardSpec =>
  dashboardSchema.parse({ id, title, widgets, layout: { cells: [] } });

const widget = (id: string, title: string) => ({
  id,
  title,
  component: "table",
  source: { connection: "acme", op: "list_things" },
  pipeline: [{ op: "extract", path: "$.data" }],
  roles: { columns: ["name"] },
});

const offer = (id: string, headline: string, connection = "acme"): AuthoredWidget =>
  ({
    id,
    source: "rule",
    widget: {
      ...widget(id, id),
      source: { connection, op: "list_things" },
    },
    headline,
    why: [],
    confirm: [],
    confidence: "inferred",
    cost: { requests: 1, onOpen: 0 },
    score: 10,
  }) as unknown as AuthoredWidget;

/** The registry as the server builds it, with everything wired. */
const build = (overrides: Partial<BuildChatRegistryInput> = {}) => {
  const dashboard = overrides.dashboard ?? board("ops", "Ops", [widget("leases", "Leases")]);
  const store = new Map<string, DashboardSpec>([[dashboard.id, dashboard]]);

  return buildChatRegistry({
    dashboard,
    reports: [],
    allDashboards: [
      { id: "ops", title: "Ops" },
      { id: "finance", title: "Finance" },
    ],
    connections: [
      { id: "acme", title: "Acme", read: true, stale: false },
      { id: "beta", title: "Beta", read: false, stale: false },
    ],
    suggestions: [offer("new-table", "This widget will list your things.")],
    board: {
      getDashboard: () => store.get(dashboard.id) ?? null,
      getDashboardById: (id) => store.get(id) ?? null,
      putDashboard: (spec) => void store.set(spec.id, spec),
      createDashboard: (title) => {
        const created = board(title.toLowerCase().replace(/\s+/g, "-"), title);
        store.set(created.id, created);
        return created;
      },
      deleteDashboard: (id) => void store.delete(id),
    },
    ...overrides,
  });
};

/** The roster component is registered first, under the dashboard's own title. */
const roster = (registry: ReturnType<typeof build>): string =>
  (registry.list()[0]?.knowledge ?? []).map((item) => item.text).join("\n");

const actionOf = (registry: ReturnType<typeof build>, id: string) =>
  registry.list()[0]?.actions?.find((action) => action.id === id);

describe("chat registry knowledge", () => {
  it("puts the roster first, where truncation cannot reach it", () => {
    const registry = build();
    expect(registry.list()[0]?.id).toBe("dashboard");
  });

  it("names every widget on the board", () => {
    const text = roster(build());
    expect(text).toContain("ON THIS DASHBOARD NOW");
    expect(text).toContain("Leases");
    expect(text).toContain("leases");
  });

  it("lists every tab and marks the current one", () => {
    const text = roster(build());
    expect(text).toContain("TABS");
    expect(text).toContain("Finance");
    expect(text).toMatch(/Ops[^;]*← current/);
  });

  it("says which connections have been read and which have not", () => {
    const text = roster(build());
    expect(text).toContain("CONNECTIONS");
    expect(text).toMatch(/Acme[^;]*read/);
    expect(text).toMatch(/Beta[^;]*not read yet/);
    // The reason suggestions are missing, said rather than left to inference.
    expect(text).toContain("Reading is what produces widget suggestions");
  });

  it("offers what can be added, labelled by connection", () => {
    const text = roster(build());
    expect(text).toContain("NOT YET CREATED");
    expect(text).toContain("new-table");
    expect(text).toContain("[acme]");
  });

  it("does not offer a widget that is already on the board", () => {
    const text = roster(
      build({ suggestions: [offer("leases", "This widget will list your leases.")] }),
    );
    expect(text).toContain("no ready-made widgets to add");
  });

  it("still builds for an empty board, rather than throwing", () => {
    const registry = build({ dashboard: board("blank", "Blank") });
    expect(registry.list()).toHaveLength(1);
    expect(roster(registry)).toContain("no widgets on it yet");
    // The actions still have somewhere to live, or an empty board is inert.
    expect(actionOf(registry, "add_widget")).toBeDefined();
  });

  it("steps aside when a widget is already called dashboard", () => {
    const registry = build({
      dashboard: board("ops", "Ops", [widget("dashboard", "A widget named dashboard")]),
    });
    // Registering twice under one id throws, which would take the chat down.
    expect(registry.list().map((component) => component.id)).toEqual(["dashboard-2", "dashboard"]);
  });
});

describe("chat registry actions", () => {
  it("requires confirmation for everything that writes, and only that", () => {
    const registry = build();
    const confirmation = (id: string) => actionOf(registry, id)?.requiresConfirmation;

    expect(confirmation("add_widget")).toBe("preview");
    expect(confirmation("remove_widget")).toBe("preview");
    expect(confirmation("create_dashboard")).toBe("preview");
    expect(confirmation("rename_dashboard")).toBe("preview");
    expect(confirmation("read_connection")).toBe("preview");

    // Destructive and unrecoverable — the one place stricter than preview.
    expect(confirmation("delete_dashboard")).toBe("strict");

    // View-only: local, reversible, nothing stored changes.
    expect(confirmation("set_time_range")).toBe("none");
    expect(confirmation("open_widget")).toBe("none");
    expect(confirmation("switch_dashboard")).toBe("none");
    expect(confirmation("open_connections")).toBe("none");
  });

  const authorize = async (registry: ReturnType<typeof build>, id: string, args: unknown) => {
    const action = actionOf(registry, id)!;
    return action.authorize?.(args as never, {} as never);
  };

  it("refuses a tab id it never showed", async () => {
    const registry = build();
    expect(await authorize(registry, "rename_dashboard", { dashboardId: "ops", title: "x" })).toBe(
      true,
    );
    expect(
      await authorize(registry, "rename_dashboard", { dashboardId: "nope", title: "x" }),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a widget id that was never offered", async () => {
    const registry = build();
    expect(await authorize(registry, "add_widget", { widgetId: "new-table" })).toBe(true);
    expect(await authorize(registry, "add_widget", { widgetId: "invented" })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("refuses a connection it never showed", async () => {
    const registry = build();
    expect(await authorize(registry, "read_connection", { connectionId: "beta" })).toBe(true);
    expect(await authorize(registry, "read_connection", { connectionId: "ghost" })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("creates a tab and reports the id it was given", async () => {
    const registry = build();
    const result = (await actionOf(registry, "create_dashboard")!.handler!(
      { title: "Finance Review" } as never,
      {} as never,
    )) as { dashboardId: string };
    expect(result.dashboardId).toBe("finance-review");
  });

  /*
   * Reading costs real requests, so the action opens the panel that prices it
   * rather than starting one. A handler that fetched here would bypass the
   * whole consent step.
   */
  it("routes a read request to the panel instead of reading", async () => {
    const registry = build();
    const result = await actionOf(registry, "read_connection")!.handler!(
      { connectionId: "beta" } as never,
      {} as never,
    );
    expect(result).toMatchObject({ opened: "connections", connectionId: "beta" });
  });
});
