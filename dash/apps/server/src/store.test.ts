import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityReportSchema, connectionSchema, dashboardSchema, fingerprintConnection } from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpecStore } from "./store.js";

/**
 * The store keeps what a file held until the file changes. These hold it to
 * the two things that makes risky: a change must still be seen, by whoever
 * made it, and nobody may change the copy every reader shares.
 */

let dir: string;
let store: SpecStore;

const connection = (title = "Demo API") =>
  connectionSchema.parse({
    id: "api",
    title,
    kind: "rest",
    baseUrl: "https://api.example.com",
    ops: [{ id: "items", title: "Items", path: "/items" }],
  });

const dashboard = (title = "Board") =>
  dashboardSchema.parse({ id: "board", title, widgets: [], layout: { cells: [] } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-store-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the spec store's kept copies", () => {
  it("hands back the same connection until its file changes", () => {
    store.putConnection(connection());
    const first = store.getConnection("api");
    expect(first?.title).toBe("Demo API");
    expect(store.getConnection("api")).toBe(first);
    expect(store.listConnections()[0]).toBe(first);
  });

  it("sees a save at once", () => {
    store.putConnection(connection());
    expect(store.getConnection("api")?.title).toBe("Demo API");
    store.putConnection(connection("Renamed"));
    expect(store.getConnection("api")?.title).toBe("Renamed");
    expect(store.listConnections().map((one) => one.title)).toEqual(["Renamed"]);

    store.putDashboard(dashboard());
    expect(store.getDashboard("board")?.title).toBe("Board");
    store.putDashboard(dashboard("Renamed board"));
    expect(store.getDashboard("board")?.title).toBe("Renamed board");
    expect(store.listDashboards().map((one) => one.title)).toEqual(["Renamed board"]);
  });

  it("sees a file edited by hand, or by another process", () => {
    store.putConnection(connection());
    expect(store.getConnection("api")?.title).toBe("Demo API");
    const path = join(dir, "connections", "api.json");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...onDisk, title: "Edited outside the server" }), "utf8");
    expect(store.getConnection("api")?.title).toBe("Edited outside the server");
  });

  it("sees a file that appeared or went without the store's doing", () => {
    expect(store.getDashboard("board")).toBeNull();
    writeFileSync(join(dir, "dashboards", "board.json"), JSON.stringify(dashboard()), "utf8");
    expect(store.getDashboard("board")?.title).toBe("Board");
    rmSync(join(dir, "dashboards", "board.json"));
    expect(store.getDashboard("board")).toBeNull();
    expect(store.listDashboards()).toEqual([]);
  });

  it("forgets what it removes", () => {
    store.putConnection(connection());
    store.putDashboard(dashboard());
    expect(store.getConnection("api")).not.toBeNull();
    expect(store.getDashboard("board")).not.toBeNull();
    store.deleteConnection("api");
    store.deleteDashboard("board");
    expect(store.getConnection("api")).toBeNull();
    expect(store.getDashboard("board")).toBeNull();
  });

  it("keeps a file that is not a spec as nothing, and reads it again once it is one", () => {
    const path = join(dir, "connections", "api.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(store.getConnection("api")).toBeNull();
    expect(store.listConnections()).toEqual([]);
    writeFileSync(path, JSON.stringify(connection()), "utf8");
    expect(store.getConnection("api")?.id).toBe("api");
  });

  it("refuses a change made in place, since every reader holds the same copy", () => {
    store.putConnection(connection());
    const held = store.getConnection("api")!;
    expect(() => {
      (held as { title: string }).title = "Changed in place";
    }).toThrow(TypeError);
    expect(() => {
      (held.ops as unknown[]).push({});
    }).toThrow(TypeError);
    expect(store.getConnection("api")?.title).toBe("Demo API");
    /* A changed spec is a new object, saved. */
    store.putConnection({ ...held, title: "Changed by saving" });
    expect(store.getConnection("api")?.title).toBe("Changed by saving");
  });

  it("bumps a report's revision past the one it holds", () => {
    const report = capabilityReportSchema.parse({
      connection: "api",
      generatedAt: new Date("2026-08-14T10:00:00.000Z").toISOString(),
      opsFingerprint: "abc123",
      resources: [],
    });
    expect(store.putReport(report).revision).toBe(1);
    expect(store.getReport("api")?.revision).toBe(1);
    expect(store.putReport(report).revision).toBe(2);
    expect(store.getReport("api")?.revision).toBe(2);
    expect(store.listReports().map((one) => one.revision)).toEqual([2]);
    store.deleteReport("api");
    expect(store.getReport("api")).toBeNull();
  });

  it("gives a kept connection the fingerprint a fresh copy of it has", () => {
    store.putConnection(connection());
    const held = store.getConnection("api")!;
    const fresh = connectionSchema.parse(JSON.parse(JSON.stringify(held)));
    expect(fingerprintConnection(held)).toBe(fingerprintConnection(fresh));
    expect(fingerprintConnection(held)).toBe(fingerprintConnection(held));
    store.putConnection({ ...held, baseUrl: "https://api.example.org" });
    expect(fingerprintConnection(store.getConnection("api")!)).not.toBe(fingerprintConnection(fresh));
  });
});
