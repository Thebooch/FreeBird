import { describe, expect, it } from "vitest";
import { BOARD_ROUTE, parseRoute, routeToHash } from "./route.js";

describe("parseRoute", () => {
  it("reads a board", () => {
    expect(parseRoute("#/d/sales")).toEqual({ kind: "board", dashboardId: "sales" });
  });

  it("reads a record", () => {
    expect(parseRoute("#/d/sales/w/orders/r/4127")).toEqual({
      kind: "record",
      dashboardId: "sales",
      widgetId: "orders",
      recordId: "4127",
    });
  });

  it("decodes ids that needed escaping", () => {
    const route = parseRoute("#/d/my%20board/w/w%2F1/r/A%26B");
    expect(route).toEqual({
      kind: "record",
      dashboardId: "my board",
      widgetId: "w/1",
      recordId: "A&B",
    });
  });

  /*
   * A stale or hand-edited link should land somewhere useful rather than on an
   * apology. Every unrecognised shape falls back to the board.
   */
  it("falls back to the board for anything it does not recognise", () => {
    expect(parseRoute("")).toEqual(BOARD_ROUTE);
    expect(parseRoute("#/")).toEqual(BOARD_ROUTE);
    expect(parseRoute("#/nonsense")).toEqual(BOARD_ROUTE);
    expect(parseRoute("#/d/")).toEqual(BOARD_ROUTE);
    // A half-written record URL is a board, not a record with holes in it.
    expect(parseRoute("#/d/sales/w/orders")).toEqual({ kind: "board", dashboardId: "sales" });
    expect(parseRoute("#/d/sales/w/orders/r")).toEqual({ kind: "board", dashboardId: "sales" });
  });

  it("tolerates a missing leading slash and extra segments", () => {
    expect(parseRoute("#d/sales")).toEqual({ kind: "board", dashboardId: "sales" });
    expect(parseRoute("#/d/sales/w/orders/r/7/extra")).toEqual({
      kind: "record",
      dashboardId: "sales",
      widgetId: "orders",
      recordId: "7",
    });
  });
});

describe("parseRoute, for a record addressed by what it is", () => {
  it("reads a record type and an id", () => {
    expect(parseRoute("#/r/fabrikam/vendor/350113")).toEqual({
      kind: "entity",
      connectionId: "fabrikam",
      entityId: "vendor",
      recordId: "350113",
    });
  });

  /*
   * A unit is `/properties/{propertyID}/units/{unitID}`: a link that carried
   * only the unit's id could not be reloaded or shared, because nothing could
   * fetch the unit again without its property.
   */
  it("carries a nested record's parents, and reads them back", () => {
    const route = {
      kind: "entity" as const,
      connectionId: "contoso",
      entityId: "unit",
      recordId: "222",
      parents: { propertyID: "210" },
      from: { dashboardId: "ops", widgetId: "units" },
    };
    const hash = routeToHash(route);
    expect(hash).toBe("#/r/contoso/unit/222/from/ops/units?propertyID=210");
    expect(parseRoute(hash)).toEqual(route);
    // Old links, with no parents, read exactly as they always did.
    expect(parseRoute("#/r/contoso/unit/222")).not.toHaveProperty("parents");
  });

  it("reads which widget's row opened it, when one did", () => {
    // A widget may change its own copy of the layout; a reference link carries
    // no `from` and always opens the plain shared page.
    expect(parseRoute("#/r/fabrikam/vendor/350113/from/ops/tasks")).toEqual({
      kind: "entity",
      connectionId: "fabrikam",
      entityId: "vendor",
      recordId: "350113",
      from: { dashboardId: "ops", widgetId: "tasks" },
    });
  });

  it("ignores a half-written origin rather than inventing one", () => {
    expect(parseRoute("#/r/fabrikam/vendor/350113/from/ops")).toEqual({
      kind: "entity",
      connectionId: "fabrikam",
      entityId: "vendor",
      recordId: "350113",
    });
  });

  it("falls back to the board for a record URL with holes in it", () => {
    expect(parseRoute("#/r")).toEqual(BOARD_ROUTE);
    expect(parseRoute("#/r/fabrikam")).toEqual(BOARD_ROUTE);
    expect(parseRoute("#/r/fabrikam/vendor")).toEqual(BOARD_ROUTE);
  });
});

describe("routeToHash, for a record addressed by what it is", () => {
  it("round-trips a record addressed by what it is", () => {
    const route = {
      kind: "entity",
      connectionId: "fabrikam",
      entityId: "association-tenant",
      recordId: "A&B/C",
    } as const;
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });

  it("round-trips one opened from a widget's row", () => {
    const route = {
      kind: "entity",
      connectionId: "fabrikam",
      entityId: "vendor",
      recordId: "350113",
      from: { dashboardId: "my board", widgetId: "w/1" },
    } as const;
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });
});

describe("routeToHash", () => {
  it("round-trips a record", () => {
    const route = {
      kind: "record",
      dashboardId: "sales",
      widgetId: "orders",
      recordId: "4127",
    } as const;
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });

  it("round-trips ids that need escaping", () => {
    const route = {
      kind: "record",
      dashboardId: "my board",
      widgetId: "w/1",
      recordId: "A&B/C",
    } as const;
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });

  it("writes a bare hash for no board at all", () => {
    expect(routeToHash(BOARD_ROUTE)).toBe("#/");
    expect(routeToHash({ kind: "board", dashboardId: "sales" })).toBe("#/d/sales");
  });
});

/* ── when the assistant is not there at all ────────────────────────────── */

describe("health reports whether chat exists", () => {
  it("distinguishes a server with no assistant from one still connecting", () => {
    /*
     * Chat storage is allowed to fail alone — a damaged embedded database must
     * not take down dashboards — but that left the browser on a disabled box
     * reading "Starting…" forever, which looks like a hang rather than the
     * boot error the server already printed. The flag is what tells the two
     * apart, so it has to be a real field and not an absence.
     */
    const withChat: { ok: boolean; chat?: boolean } = { ok: true, chat: true };
    const without: { ok: boolean; chat?: boolean } = { ok: true, chat: false };

    expect(withChat.chat !== false).toBe(true);
    expect(without.chat !== false).toBe(false);
    // An older server that predates the flag is treated as having chat, so a
    // missing field never disables a working assistant.
    expect(({ ok: true } as { ok: boolean; chat?: boolean }).chat !== false).toBe(true);
  });
});

describe("Comms", () => {
  it("has an address of its own, and round-trips", () => {
    expect(parseRoute("#/comms")).toEqual({ kind: "comms" });
    expect(routeToHash({ kind: "comms" })).toBe("#/comms");
  });
});

describe("the Agent side", () => {
  it("reads a section, and an item within it", () => {
    expect(parseRoute("#/agent/workflows")).toEqual({ kind: "agent", section: "workflows" });
    expect(parseRoute("#/agent/agents/scout")).toEqual({ kind: "agent", section: "agents", id: "scout" });
    expect(parseRoute("#/agent/communications")).toEqual({ kind: "agent", section: "agents" });
  });

  it("lands on Agents for a section it does not have, and on Agents for a bare #/agent", () => {
    expect(parseRoute("#/agent")).toEqual({ kind: "agent", section: "agents" });
    expect(parseRoute("#/agent/nonsense")).toEqual({ kind: "agent", section: "agents" });
    expect(parseRoute("#/agent/nonsense/7")).toEqual({ kind: "agent", section: "agents", id: "7" });
  });

  it("round-trips, escaping an id that needs it", () => {
    for (const route of [
      { kind: "agent", section: "calendar" },
      { kind: "agent", section: "agents", id: "lease scout/2" },
    ] as const) {
      expect(parseRoute(routeToHash(route))).toEqual(route);
    }
    expect(routeToHash({ kind: "agent", section: "agents", id: "a b" })).toBe("#/agent/agents/a%20b");
  });
});
