import { describe, expect, it } from "vitest";
import { executeWidget } from "@freebirdai/dash-runtime";
import {
  compileBrief,
  entitySchema,
  parseWidget,
  recompileWidget,
  resolveRange,
  resourceSchema,
  type EntitySpec,
  type WidgetBrief,
} from "@freebirdai/dash-spec";
import { widgetDigest } from "./grants.js";

/**
 * The brief a widget was built from, kept with it.
 *
 * Without this a widget's decisions die the moment it reaches a board: the
 * setup card's controls come from a draft, and the draft is thrown away on
 * confirm. What is guarded here is the pair of properties that make storing it
 * safe — a widget that never had one is untouched, and a widget that has one
 * can be rebuilt from it.
 */

const entity: EntitySpec = entitySchema.parse({
  id: "task",
  resource: "task",
  name: { one: "Task", many: "Tasks" },
  kind: "work",
  identity: { field: "Id", observed: true },
  display: { title: ["Title"], status: "Status" },
  fields: [
    { path: "Id", visibility: "hidden" },
    { path: "Title", label: "Summary", visibility: "primary" },
    { path: "Status", label: "Status", visibility: "primary" },
    { path: "Cost", label: "Cost", semantic: "currency", visibility: "detail" },
  ],
});

const resource = resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" });

const compile = (brief: Partial<WidgetBrief> = {}) =>
  compileBrief({
    brief: { entity: "task", intent: "records", ...brief } as WidgetBrief,
    entity,
    resource,
    connection: "api",
    id: "w1",
  });

describe("a widget that carries its brief", () => {
  it("keeps the request it was compiled from", () => {
    const widget = compile({ filters: [{ field: "Status" }] }).widget;
    expect(widget?.brief).toEqual({
      entity: "task",
      intent: "records",
      filters: [{ field: "Status" }],
    });
  });

  it("compiles back to the same widget, which is what makes it editable", () => {
    /*
     * The property the settings panel rests on: reading the brief, changing
     * one thing and compiling again must be a change of that one thing. If a
     * round trip were lossy, every edit would also rewrite whatever the round
     * trip lost.
     */
    const first = compile({ filters: [{ field: "Status" }], sort: { field: "Title" } }).widget!;
    const again = compileBrief({
      brief: first.brief!,
      entity,
      resource,
      connection: "api",
      id: "w1",
    }).widget;

    expect(again).toEqual(first);
  });

  it("leaves a widget that never had one hashing exactly as it did", () => {
    /*
     * Approvals are keyed on a digest of the widget, so a field that appeared
     * on every widget — a `.default({})` rather than an `.optional()` — would
     * change every digest and silently revoke every approval on every board.
     * `canonicalize` drops undefined keys, which is what makes absent free.
     */
    const stored = {
      id: "old",
      title: "Built before briefs existed",
      component: "table",
      source: { connection: "api", op: "tasks_list" },
      roles: { columns: ["Title"] },
    };
    const widget = parseWidget(stored).value!;

    expect(widget.brief).toBeUndefined();
    expect(widgetDigest(widget)).toBe(
      widgetDigest(parseWidget({ ...stored, extraneous: undefined }).value!),
    );
  });
});

describe("recompiling an edited brief", () => {
  const previous = parseWidget({
    ...compile({ filters: [{ field: "Status" }] }).widget!,
    id: "on-the-board",
    presentation: { settings: { density: "compact" } },
    confirmed: ["Cost:cents"],
    producedBy: { model: "some-model", at: "2026-01-01T00:00:00.000Z" },
    format: { Cost: { semantic: "currency", currency: "USD" } },
  }).value!;

  const edited = compile({ filters: [{ field: "Status" }], columns: ["Title", "Cost"] }).widget!;
  const merged = recompileWidget(previous, edited);

  it("keeps the widget's own id, without which its place on the board is lost", () => {
    // A re-id'd widget orphans its layout cell — and for one in a group, drops
    // the group below two members, which makes the whole board unstorable.
    expect(merged.id).toBe("on-the-board");
  });

  it("keeps what no brief can say", () => {
    expect(merged.presentation).toEqual(previous.presentation);
    expect(merged.confirmed).toEqual(["Cost:cents"]);
    expect(merged.producedBy).toEqual(previous.producedBy);
    expect(merged.format.Cost).toEqual({ semantic: "currency", currency: "USD" });
  });

  it("takes the edit itself from the new compilation", () => {
    expect(merged.roles).toEqual(edited.roles);
    expect(merged.pipeline).toEqual(edited.pipeline);
    expect(merged.brief?.columns).toEqual(["Title", "Cost"]);
  });

  it("still parses, so an edit can be stored", () => {
    expect(parseWidget(merged).ok).toBe(true);
  });
});

/**
 * Reading the values correctly, from what the API said they are.
 *
 * The compiler emitted no coercion at all, so a widget built from a brief
 * showed whatever the endpoint sent: an ISO string where a date belonged, and
 * — where a schema declares minor units — a number a hundred times too large,
 * rendered as currency by a renderer guessing from the column's name. That is
 * the most damaging failure this product can produce, because the result looks
 * perfect.
 *
 * The rule these guard: a date is derived because "iso8601" means one thing
 * everywhere, and money is not, because a schema claiming minor units is a
 * claim rather than a measurement.
 */

const money = (input: Record<string, unknown> = {}): EntitySpec =>
  entitySchema.parse({
    id: "charge",
    resource: "charge",
    name: { one: "Charge", many: "Charges" },
    kind: "money",
    identity: { field: "Id", observed: true },
    display: { title: ["Memo"] },
    fields: [
      { path: "Id", visibility: "hidden" },
      { path: "Memo", label: "Memo", visibility: "primary" },
      { path: "PostedOn", label: "Posted", format: "iso8601", visibility: "primary" },
      { path: "Amount", label: "Amount", format: "minor_units", visibility: "primary" },
    ],
    ...input,
  });

const chargeResource = resourceSchema.parse({
  id: "charge",
  title: "Charges",
  listOp: "charges_list",
});

const compileCharges = (entity: EntitySpec) =>
  compileBrief({
    brief: {
      entity: "charge",
      intent: "records",
      columns: ["Memo", "PostedOn", "Amount"],
    } as WidgetBrief,
    entity,
    resource: chargeResource,
    connection: "api",
    id: "w1",
  });

describe("units and formats, as facts about the API", () => {
  it("reads a declared date without anybody saying so", () => {
    const widget = compileCharges(money()).widget!;
    expect(widget.pipeline).toContainEqual({
      op: "coerce",
      fields: { PostedOn: "iso->datetime" },
    });
    // Said on the widget too, rather than left for the renderer to infer from
    // the column's name — which is how a date called `Period` renders raw.
    expect(widget.format.PostedOn).toEqual({ semantic: "timestamp" });
  });

  it("leaves minor units alone until something confirms them", () => {
    /*
     * The schema says `minor_units`. Acting on that alone divides every value
     * by a hundred on the strength of a claim nobody checked.
     */
    const widget = compileCharges(money()).widget!;
    const coerce = widget.pipeline.find((step) => step.op === "coerce");
    expect(coerce && coerce.op === "coerce" ? coerce.fields.Amount : undefined).toBeUndefined();
    expect(widget.format.Amount).toBeUndefined();
  });

  it("reads them once a person has, and then for every widget over that field", () => {
    const confirmed = money({
      fields: [
        { path: "Id", visibility: "hidden" },
        { path: "Memo", label: "Memo", visibility: "primary" },
        { path: "PostedOn", label: "Posted", format: "iso8601", visibility: "primary" },
        {
          path: "Amount",
          label: "Amount",
          format: "minor_units",
          coercion: "money:cents->major",
          visibility: "primary",
        },
      ],
    });
    const widget = compileCharges(confirmed).widget!;
    expect(widget.pipeline).toContainEqual({
      op: "coerce",
      fields: { PostedOn: "iso->datetime", Amount: "money:cents->major" },
    });
    expect(widget.format.Amount).toEqual({ semantic: "currency" });

    // The whole point: 12345 cents is $123.45, not $12,345.00.
    const result = executeWidget(
      widget,
      [{ Id: 1, Memo: "Rent", PostedOn: "2026-09-01T00:00:00Z", Amount: 12345 }],
      { now: 0, params: { range: resolveRange({ preset: "30d", now: 0 }), filters: {} }, timeZone: "UTC" },
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ Amount: 123.45 });
  });

  it("coerces after flattening, because a coercion names a column", () => {
    const nested = entitySchema.parse({
      id: "charge",
      resource: "charge",
      name: { one: "Charge", many: "Charges" },
      kind: "money",
      identity: { field: "Id", observed: true },
      display: { title: ["Memo"] },
      fields: [
        { path: "Id", visibility: "hidden" },
        { path: "Memo", label: "Memo", visibility: "primary" },
        { path: "Posted", kinds: ["object"], visibility: "detail" },
        { path: "Posted.On", label: "Posted", format: "iso8601", visibility: "primary" },
      ],
    });
    const widget = compileBrief({
      brief: { entity: "charge", intent: "records", columns: ["Memo", "Posted.On"] } as WidgetBrief,
      entity: nested,
      resource: chargeResource,
      connection: "api",
      id: "w1",
    }).widget!;

    const ops = widget.pipeline.map((step) => step.op);
    expect(ops.indexOf("derive")).toBeLessThan(ops.indexOf("coerce"));
    expect(widget.pipeline).toContainEqual({
      op: "coerce",
      fields: { Posted_On: "iso->datetime" },
    });
  });

  it("says nothing about a field the API said nothing about", () => {
    const plain = money({
      fields: [
        { path: "Id", visibility: "hidden" },
        { path: "Memo", label: "Memo", visibility: "primary" },
      ],
    });
    const widget = compileBrief({
      brief: { entity: "charge", intent: "records" } as WidgetBrief,
      entity: plain,
      resource: chargeResource,
      connection: "api",
      id: "w1",
    }).widget!;
    expect(widget.pipeline.some((step) => step.op === "coerce")).toBe(false);
    expect(widget.format).toEqual({});
  });
});
