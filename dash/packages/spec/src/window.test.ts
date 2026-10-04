import { describe, expect, it } from "vitest";
import { connectionSchema, getOp } from "./connection.js";
import { interpolate, paramsForWidget, rangeForWindow, resolveRange } from "./params.js";

/*
 * A widget's own time: the window its request named, in place of the board's.
 * Regression: read within the board's thirty days, "since 1 June" counted
 * one month of it.
 */

const NOW = Date.UTC(2026, 8, 29, 12);
const board = resolveRange({ preset: "30d", now: NOW });

describe("a widget's own time window", () => {
  it("reads from its date to now, ending where a preset would so the key holds still", () => {
    const range = rangeForWindow({ from: "2026-06-01" }, board, NOW);
    expect(range.start).toBe(Date.parse("2026-06-01"));
    expect(range.end).toBeLessThanOrEqual(NOW);
    expect(range.end).toBe(rangeForWindow({ from: "2026-06-01" }, board, NOW + 30_000).end);
    expect(range.preset).toBe("custom");
  });

  it("reads between two dates, and keeps the board's where the window cannot be read", () => {
    expect(rangeForWindow({ from: "2026-07-01", to: "2026-08-01" }, board, NOW)).toMatchObject({
      start: Date.parse("2026-07-01"),
      end: Date.parse("2026-08-01"),
    });
    expect(rangeForWindow({ from: "not a date" }, board, NOW)).toBe(board);
    expect(rangeForWindow({ from: "2026-08-01", to: "2026-07-01" }, board, NOW)).toBe(board);
    expect(rangeForWindow(undefined, board, NOW)).toBe(board);
  });

  it("changes only the range of a widget's parameters", () => {
    const params = { range: board, filters: { region: "emea" } };
    expect(paramsForWidget({}, params, NOW)).toBe(params);
    const own = paramsForWidget({ timeWindow: { from: "2026-06-01" } }, params, NOW);
    expect(own.filters).toBe(params.filters);
    expect(own.range.start).toBe(Date.parse("2026-06-01"));
  });

  it("caches connector code that reads the window under the window", () => {
    const connection = (code: string) =>
      connectionSchema.parse({
        id: "c",
        title: "C",
        kind: "rest",
        baseUrl: "https://api.c.test",
        auth: { type: "connector", credentials: [] },
        connector: {
          code,
          hash: `sha256:${"0".repeat(64)}`,
          hooks: ["read"],
          serves: ["x"],
          authority: { destinations: [{ host: "api.c.test", methods: ["GET"], credentials: [] }] },
          author: { by: "person", at: "2026-09-28T00:00:00.000Z" },
        },
        ops: [{ id: "x", title: "X", path: "/x", servedBy: "connector" }],
      });
    expect(getOp(connection("export async function read(ctx) { return ctx.range.start; }"), "x")?.usesRange).toBe(true);
    expect(getOp(connection("export async function read(ctx) { return []; }"), "x")?.usesRange).toBe(false);
  });
});

/* A number whose request named no time counts every record: "how many" reads as "ever". */
describe("all time", () => {
  it("asks without date bounds: range tokens resolve to nothing", () => {
    const params = paramsForWidget({ timeWindow: { all: true } }, { range: board, filters: {} }, NOW);
    expect(params.range).toMatchObject({ start: 0, end: board.end, all: true });
    expect(interpolate("{{range.start | unix}}", params)).toBe("");
    expect(interpolate("{{range.end | iso}}", params)).toBe("");
    /* The board's own range still resolves as before. */
    expect(interpolate("{{range.start | unix}}", { range: board, filters: {} })).toBe(String(Math.floor(board.start / 1000)));
  });
});
