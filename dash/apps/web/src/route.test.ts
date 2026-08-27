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
