import { describe, expect, it } from "vitest";
import type { OpReader } from "../context/types.js";
import { READ_TOOL, identityValue, readRecords, readReferenced } from "./read.js";
import type { Reference, ToolBinding, ToolDeps } from "./types.js";

/**
 * Opening one record, and being honest about what it cost.
 *
 * The failure this exists for: asked for the notes on a task it had already
 * found, the assistant re-read the same fifty list rows twice and twice said
 * the description "was not included in the available rows". It was one request
 * away on the record's own endpoint.
 */

const binding = (over: Partial<ToolBinding> = {}): ToolBinding => ({
  verb: "read",
  id: "conversation",
  connection: "helpdesk",
  connectionTitle: "Helpdesk",
  resource: "conversation",
  title: "Conversation",
  op: "tickets.get",
  describes: "Support threads",
  idParam: "ref",
  idField: "reference",
  listOp: "tickets.list",
  ...over,
});

const deps = (read: OpReader): ToolDeps => ({
  read,
  resolved: { range: { start: 0, end: 1, grain: "1d", preset: "30d" }, filters: {} },
  rowsOf: (body) =>
    Array.isArray(body)
      ? (body as Record<string, unknown>[])
      : body && typeof body === "object"
        ? [body as Record<string, unknown>]
        : [],
  rowsPathFor: () => "$",
});

const reader = (
  bodies: Record<string, unknown>,
  calls: string[] = [],
  opts: { cacheOnly?: string[] } = {},
): OpReader =>
  (async (input) => {
    const id = String(Object.values(input.params)[0] ?? "");
    calls.push(`${input.op}:${id}`);
    opts.cacheOnly?.push(String(input.cacheOnly));
    if (!(id in bodies)) return null;
    return { ok: true as const, body: bodies[id], requests: 1, truncated: false };
  }) as OpReader;

describe("identityValue", () => {
  it("reads a plain identifier", () => {
    expect(identityValue({ SiteRef: 42 }, "SiteRef")).toEqual(["42"]);
  });

  /*
   * The two shapes that fail silently when treated as a scalar: a list never
   * equals an id, and an object stringifies to "[object Object]". Both look
   * exactly like a record with nothing linked.
   */
  it("reads a list-valued key", () => {
    expect(identityValue({ Ids: [1, 2] }, "Ids")).toEqual(["1", "2"]);
  });

  it("reads an object reference by the target's own id field", () => {
    expect(identityValue({ Property: { Id: 306904, Href: "…" } }, "Property", "Id")).toEqual([
      "306904",
    ]);
  });

  it("finds an id inside an object even when the field name is unknown", () => {
    expect(identityValue({ Owner: { uuid: "abc" } }, "Owner")).toEqual(["abc"]);
  });

  it("reads a dotted path", () => {
    expect(identityValue({ Property: { Id: 7 } }, "Property.Id")).toEqual(["7"]);
  });

  it("reads a list of object references", () => {
    expect(identityValue({ Units: [{ Id: 1 }, { Id: 2 }] }, "Units", "Id")).toEqual(["1", "2"]);
  });

  it("returns nothing rather than a placeholder when the field is absent or null", () => {
    expect(identityValue({}, "Missing")).toEqual([]);
    expect(identityValue({ Ref: null }, "Ref")).toEqual([]);
    expect(identityValue({ Owner: {} }, "Owner")).toEqual([]);
  });
});

describe("readRecords", () => {
  it("opens the record and says it did", async () => {
    const calls: string[] = [];
    const result = await readRecords({
      binding: binding(),
      ids: ["77"],
      deps: deps(reader({ "77": { reference: "77", body: "Water on side of house" } }, calls)),
    });

    expect(calls).toEqual(["tickets.get:77"]);
    expect(result.records).toEqual([{ reference: "77", body: "Water on side of house" }]);
    expect(result.requests).toBe(1);
    expect(result.note).toContain("Opened the full conversation record");
    expect(result.note).toContain("1 request");
  });

  it("de-duplicates ids so the same record is never bought twice", async () => {
    const calls: string[] = [];
    await readRecords({
      binding: binding(),
      ids: ["5", "5", "5"],
      deps: deps(reader({ "5": { reference: "5" } }, calls)),
    });
    expect(calls).toEqual(["tickets.get:5"]);
  });

  /*
   * One request each, so the fan-out is what has to be capped — and the cap is
   * reported, because "nothing was found" and "I only looked at three of them"
   * are different claims.
   */
  it("caps the fan-out and says how many it covered", async () => {
    const calls: string[] = [];
    const result = await readRecords({
      binding: binding(),
      ids: ["1", "2", "3", "4", "5"],
      deps: deps(reader({ "1": {}, "2": {}, "3": {}, "4": {}, "5": {} }, calls)),
    });
    expect(calls).toHaveLength(3);
    expect(result.note).toContain("3 of 5");
  });

  it("reads cache-only when told to, so what is on screen is never re-bought", async () => {
    const cacheOnly: string[] = [];
    await readRecords({
      binding: binding(),
      ids: ["1"],
      deps: deps(reader({ "1": {} }, [], { cacheOnly })),
      cacheOnly: true,
    });
    expect(cacheOnly).toEqual(["true"]);
  });

  /*
   * A 403 says the key works and lacks a scope, which is the one part of this
   * somebody can act on. Folding it into "could not be read" throws that away.
   */
  it("passes the API's own reason through when it refuses", async () => {
    const refusing = (async () => ({
      ok: false as const,
      reason: "the key is not permitted to read this endpoint",
    })) as OpReader;
    const result = await readRecords({ binding: binding(), ids: ["1"], deps: deps(refusing) });
    expect(result.records).toEqual([]);
    expect(result.note).toContain("not permitted");
    expect(result.refused).toContain("not permitted");
    expect(result.requests).toBe(0);
  });

  it("reports the ones it could not open rather than implying they are empty", async () => {
    const result = await readRecords({
      binding: binding(),
      ids: ["1", "gone"],
      deps: deps(reader({ "1": { reference: "1" } })),
    });
    expect(result.records).toHaveLength(1);
    expect(result.missed).toEqual(["gone"]);
    expect(result.warnings.join(" ")).toContain("1 of the 2");
  });

  it("says so rather than guessing when the API has no by-id endpoint", async () => {
    const result = await readRecords({
      binding: binding({ idParam: undefined }),
      ids: ["1"],
      deps: deps(reader({})),
    });
    expect(result.requests).toBe(0);
    expect(result.note).toContain("no endpoint that takes an identifier");
  });

  it("spends nothing when there is no identifier to use", async () => {
    const calls: string[] = [];
    const result = await readRecords({
      binding: binding(),
      ids: [],
      deps: deps(reader({}, calls)),
    });
    expect(calls).toEqual([]);
    expect(result.note).toContain("No identifier was available");
  });
});

describe("readReferenced", () => {
  const reference = (over: Partial<Reference> = {}): Reference => ({
    to: binding({ id: "property", resource: "property", op: "get_property", idParam: "propertyId", idField: "Id" }),
    field: "Property",
    kind: "objectRef",
    title: "Property",
    ...over,
  });

  /*
   * The identifier comes off the record already in hand, which is what makes
   * this a lookup rather than a second search — and what makes it work on an
   * API offering no way to search for the thing at all.
   */
  it("opens the record a held record points at", async () => {
    const calls: string[] = [];
    const result = await readReferenced({
      reference: reference(),
      from: [{ reference: "77", Property: { Id: 306904 } }],
      deps: deps(reader({ "306904": { Id: 306904, Name: "12 Example Street" } }, calls)),
    });
    expect(calls).toEqual(["get_property:306904"]);
    expect(result.records[0]).toMatchObject({ Name: "12 Example Street" });
  });

  it("gathers ids across several held records without repeating one", async () => {
    const calls: string[] = [];
    await readReferenced({
      reference: reference({ field: "PropertyId", kind: "scalar" }),
      from: [{ PropertyId: 1 }, { PropertyId: 2 }, { PropertyId: 1 }],
      deps: deps(reader({ "1": {}, "2": {} }, calls)),
    });
    expect(calls).toEqual(["get_property:1", "get_property:2"]);
  });

  it("spends nothing when the held records do not carry the field", async () => {
    const calls: string[] = [];
    const result = await readReferenced({
      reference: reference(),
      from: [{ reference: "77" }],
      deps: deps(reader({}, calls)),
    });
    expect(calls).toEqual([]);
    expect(result.requests).toBe(0);
  });
});

describe("READ_TOOL", () => {
  /*
   * Static on purpose: the engine takes its tool schemas once, and connections
   * come and go afterwards. What can actually be opened is listed in the
   * workspace knowledge, which is rebuilt every turn — see `readRoster`.
   */
  it("says what the verb is for without enumerating what exists", () => {
    expect(READ_TOOL.name).toBe("read_record");
    expect(READ_TOOL.description).toContain("one request away");
    expect(READ_TOOL.description).toContain("what you know about this workspace");
  });
});
