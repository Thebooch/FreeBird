import { describe, expect, it } from "vitest";
import { connectionSchema, opUsesRange, resolveOp } from "./connection.js";
import { queryKey, resolveRange } from "./params.js";
import type { ResolvedParams } from "./params.js";

/**
 * What a cached answer is an answer *to*.
 *
 * The expensive mistake here is scoping a key by something the endpoint never
 * sends. A relative window is re-resolved into a new bucket every few minutes,
 * so an endpoint that ignores the range was getting a fresh key — and a fresh
 * upstream call — for a body identical by construction. Measured on two real
 * connections: none of their 243 endpoints read the range, and the whole cache
 * was being discarded every fifteen minutes for nothing.
 *
 * The opposite mistake is worse and is why the flag defaults to true: two
 * windows sharing one key serves one widget another's rows.
 */

const at = (iso: string) => new Date(iso).getTime();

const params = (now: string): ResolvedParams => ({
  range: resolveRange({ preset: "30d", now: at(now) }),
  filters: {},
});

const connection = (input: Record<string, unknown> = {}) =>
  connectionSchema.parse({
    id: "acme",
    title: "Acme",
    kind: "rest",
    baseUrl: "https://api.example.com",
    ops: [
      { id: "vendors", title: "Vendors", path: "/v1/vendors" },
      {
        id: "since",
        title: "Recent",
        path: "/v1/events",
        query: { after: "{{range.start | iso}}" },
      },
      { id: "byPath", title: "Window", path: "/v1/days/{{range.start | date}}" },
    ],
    ...input,
  });

describe("opUsesRange", () => {
  const acme = connection();
  const def = (id: string) => acme.ops.find((op) => op.id === id)!;

  it("is false for an endpoint that sends no range token", () => {
    expect(opUsesRange(acme, def("vendors"))).toBe(false);
  });

  it("is true when the op writes one itself", () => {
    expect(opUsesRange(acme, def("since"))).toBe(true);
  });

  it("is true when the token is in the path", () => {
    expect(opUsesRange(acme, def("byPath"))).toBe(true);
  });

  /* The whole point of declaring a date convention once: a list endpoint
   * inherits it without writing a token, so the flag has to read the dialect
   * as well as the op. */
  it("is true when the dialect supplies the convention", () => {
    const dated = connection({
      dialect: { timeFilter: { param: "from", endParam: "to", format: "iso" } },
    });
    expect(opUsesRange(dated, dated.ops.find((op) => op.id === "vendors")!)).toBe(true);
  });

  it("is carried onto the resolved op", () => {
    expect(resolveOp(acme, def("vendors")).usesRange).toBe(false);
    expect(resolveOp(acme, def("since")).usesRange).toBe(true);
  });
});

describe("queryKey", () => {
  const early = params("2026-09-22T10:01:00Z");
  const later = params("2026-09-22T10:31:00Z");

  it("gives an endpoint that ignores the range one key across bucket rolls", () => {
    // Two resolutions half an hour apart: different windows, same endpoint.
    expect(early.range.start).not.toBe(later.range.start);
    expect(queryKey("acme", "vendors", {}, early, false)).toBe(
      queryKey("acme", "vendors", {}, later, false),
    );
  });

  it("still separates windows for an endpoint that reads the range", () => {
    expect(queryKey("acme", "since", {}, early, true)).not.toBe(
      queryKey("acme", "since", {}, later, true),
    );
  });

  /* A caller that does not know must not be the one to collide two windows. */
  it("keeps the window by default", () => {
    expect(queryKey("acme", "since", {}, early)).not.toBe(queryKey("acme", "since", {}, later));
  });

  /* Filters are `{{param.x}}` values the endpoint really does send, so they
   * stay in the key whether or not the range does. */
  it("still separates two filter values on a range-free endpoint", () => {
    const one: ResolvedParams = { ...early, filters: { status: "open" } };
    const two: ResolvedParams = { ...early, filters: { status: "closed" } };
    expect(queryKey("acme", "vendors", {}, one, false)).not.toBe(
      queryKey("acme", "vendors", {}, two, false),
    );
  });

  it("still separates two parameter sets", () => {
    expect(queryKey("acme", "vendors", { page: 1 }, early, false)).not.toBe(
      queryKey("acme", "vendors", { page: 2 }, early, false),
    );
  });

  it("leaves the key of a range-reading endpoint exactly as it was", () => {
    // The shape is unchanged for the case that was always correct, so nothing
    // already cached is orphaned by this change.
    expect(queryKey("acme", "since", {}, early, true)).toBe(
      `acme.since|[]|${early.range.start}:${early.range.end}:${early.range.grain}:[]`,
    );
  });
});
