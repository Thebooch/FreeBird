import type { ConciergeContext } from "@freebirdai/dash-agent";
import { emptyContext } from "@freebirdai/dash-agent";
import { describe, expect, it } from "vitest";
import { describeOpenables, openFrom, openableFrom } from "./reach.js";
import type { Candidate } from "./types.js";
import type { ToolBinding } from "../tools/types.js";

/**
 * Where else the answer could be.
 *
 * Every fixture here is a made-up API — "widget" records with an "audit"
 * collection under them and an "owner" they point at. That is deliberate and
 * load-bearing: if any of this needed a real vendor's shape to pass, the code
 * would be keyed on one, and the whole point is that it is keyed on the
 * relation graph instead. An API that models the same information differently
 * produces different options and reads the same.
 */

const listOp = "list_widgets";

const detail: ToolBinding = {
  verb: "read",
  id: "widget",
  connection: "acme",
  connectionTitle: "Acme",
  resource: "widget",
  title: "Widget",
  op: "get_widget",
  describes: "one widget",
  idParam: "widgetId",
  idField: "Ref",
  listOp,
};

const owner: ToolBinding = {
  verb: "read",
  id: "owner",
  connection: "acme",
  connectionTitle: "Acme",
  resource: "owner",
  title: "Owner",
  op: "get_owner",
  describes: "one owner",
  idParam: "ownerId",
  idField: "Ref",
  listOp: "list_owners",
};

const context = (over: Partial<ConciergeContext> = {}): ConciergeContext => ({
  ...emptyContext,
  connections: [{ id: "acme", title: "Acme" }],
  ...over,
});

const withEverything = context({
  children: [
    {
      id: "widget-audit",
      parentOp: listOp,
      title: "Audit entries",
      op: "list_widget_audit",
      path: "/widgets/{widgetId}/audit",
      resource: "audit entry",
      parentIdField: "Ref",
    },
  ],
  joins: [
    {
      id: "widget-owner",
      fromOp: listOp,
      toOp: "list_owners",
      title: "The owner this widget belongs to",
      leftField: "OwnerRef",
      rightField: "Ref",
      fetch: { mode: "filtered" },
    },
  ] as ConciergeContext["joins"],
});

const candidate: Candidate = {
  kind: "widget",
  id: "board-widget",
  title: "All widgets",
  describes: "every widget",
  connection: "acme",
  op: listOp,
  fields: ["Ref", "Name"],
  cached: false,
};

describe("openableFrom", () => {
  it("offers the record's own fuller version when one can be opened", () => {
    const options = openableFrom({
      context: context(),
      bindings: [detail],
      op: listOp,
    });
    expect(options).toHaveLength(1);
    expect(options[0]?.kind).toBe("record");
    expect(options[0]?.title).toContain("widget");
  });

  it("offers a collection the relation graph says hangs off the record", () => {
    const options = openableFrom({ context: withEverything, bindings: [], op: listOp });
    expect(options.map((option) => option.kind)).toEqual(["collection"]);
    expect(options[0]?.title).toBe("Audit entries");
  });

  /*
   * All three at once, and this is the case the search path could not see.
   * Notes are a subcollection on one API and a field on the detail record on
   * the next; a step that saw only one kind would report the other as absent.
   */
  it("offers all three kinds together", () => {
    const options = openableFrom({
      context: withEverything,
      bindings: [detail, owner],
      op: listOp,
    });
    expect(options.map((option) => option.kind)).toEqual(["record", "collection", "reference"]);
  });

  it("offers nothing when the API exposes nothing further", () => {
    expect(openableFrom({ context: context(), bindings: [], op: listOp })).toEqual([]);
  });

  /* A record with no by-id endpoint cannot be opened, and is not offered. */
  it("does not offer a record the API has no way to open", () => {
    const noDetail = { ...detail, listOp: "something_else" };
    expect(openableFrom({ context: context(), bindings: [noDetail], op: listOp })).toEqual([]);
  });
});

describe("describeOpenables", () => {
  /*
   * The reply quotes these. An op id in a sentence is the product's plumbing,
   * and a user who has to learn it in order to ask for their own data has been
   * handed the implementation as an interface.
   */
  it("describes options in words, never as ids", () => {
    const described = describeOpenables(
      openableFrom({ context: withEverything, bindings: [detail, owner], op: listOp }),
    );
    expect(described).toHaveLength(3);
    for (const entry of described) {
      expect(entry.title).not.toContain("list_");
      expect(entry.title).not.toContain("get_");
      expect(Object.keys(entry).sort()).toEqual(["note", "title"]);
    }
  });
});

describe("openFrom", () => {
  const deps = (body: unknown) => ({
    read: async () => ({ ok: true as const, body, requests: 1, truncated: false }),
    resolved: { filters: {} } as never,
    rowsOf: (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []),
    rowsPathFor: () => "",
  });

  /*
   * Whichever mechanism ran, the result is evidence. That is what lets the
   * search loop judge it exactly as it judges any other read, instead of
   * growing a second path for things reached this way.
   */
  it("normalises an opened record to evidence", async () => {
    const opened = await openFrom({
      chosen: openableFrom({ context: context(), bindings: [detail], op: listOp })[0]!,
      subject: [{ Ref: "7", Name: "A" }],
      from: candidate,
      deps: deps([{ Ref: "7", Name: "A", Detail: "the long text a list leaves out" }]) as never,
      read: deps(null).read as never,
      resolved: { filters: {} } as never,
      rowsOf: deps(null).rowsOf,
      rowsPath: "",
    });

    expect(opened.evidence).not.toBeNull();
    expect(opened.evidence?.rows[0]).toMatchObject({ Detail: "the long text a list leaves out" });
    expect(opened.evidence?.candidate.op).toBe("get_widget");
    expect(opened.evidence?.candidate.title).toContain("opened in full");
    expect(opened.op).toBe("get_widget");
  });

  /*
   * Read, found nothing, and said so. Distinct from "could not be reached" —
   * the note still travels, because a request was spent either way.
   */
  it("returns no evidence when there was nothing to open", async () => {
    const opened = await openFrom({
      chosen: openableFrom({ context: context(), bindings: [detail], op: listOp })[0]!,
      subject: [{ Name: "no identifier here" }],
      from: candidate,
      deps: deps([]) as never,
      read: deps(null).read as never,
      resolved: { filters: {} } as never,
      rowsOf: deps(null).rowsOf,
      rowsPath: "",
    });
    expect(opened.evidence).toBeNull();
    expect(opened.note).not.toBe("");
  });
});
