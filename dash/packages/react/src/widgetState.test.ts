import { describe, expect, it } from "vitest";
import type { QueryEntry } from "./store.js";
import type { EntityLinkView, WidgetSpec } from "@freebirdai/dash-spec";
import { RecordIndex, indexPlan } from "./recordStore.js";
import { deriveWidgetState, heldRecordFor } from "./useWidgetData.js";

/**
 * The rules that decide whether somebody sees numbers or an apology.
 *
 * Tested against the pure function rather than through a render, because the
 * behaviour worth pinning is a set of rules about partial results and none of
 * it needs React — and these suites run under `renderToStaticMarkup`, which
 * cannot show a second state after an effect anyway.
 */
describe("deriveWidgetState", () => {
  const ok = (body: unknown = [{ id: 1 }]): QueryEntry => ({
    status: "ok",
    body,
    fetchedAt: 1_000,
    startedAt: 900,
  });

  const loading = (body?: unknown): QueryEntry => ({
    status: "loading",
    ...(body !== undefined ? { body } : {}),
    fetchedAt: body === undefined ? 0 : 1_000,
    startedAt: 2_000,
  });

  const failed = (body?: unknown): QueryEntry => ({
    status: "error",
    ...(body !== undefined ? { body } : {}),
    fetchedAt: body === undefined ? 0 : 1_000,
    startedAt: 2_000,
    error: {
      message: "rate limited by demo",
      userMessage: "The API asked for fewer requests.",
      status: 429,
      retryAt: 3_000,
    },
  });

  const derive = (input: {
    required: readonly (QueryEntry | undefined)[];
    optional?: readonly (QueryEntry | undefined)[];
    rendered?: boolean;
  }) =>
    deriveWidgetState({
      required: input.required,
      optional: input.optional ?? [],
      rendered: input.rendered ?? false,
    });

  it("renders when every required source has landed", () => {
    const state = derive({ required: [ok()] });
    expect(state.ready).toBe(true);
    expect(state.blocked).toBe(false);
    expect(state.failure).toBeNull();
  });

  it("waits while a required source is still in flight with nothing behind it", () => {
    const state = derive({ required: [ok(), loading()] });
    expect(state.ready).toBe(false);
    // Still loading is not an error — no error card for a request in progress.
    expect(state.blocked).toBe(false);
  });

  /*
   * The regression this whole change exists for: a refresh must not blank a
   * widget that already has rows.
   */
  it("keeps rendering through a refresh, because the previous body is still there", () => {
    const state = derive({ required: [loading([{ id: 1 }])] });
    expect(state.ready).toBe(true);
    expect(state.blocked).toBe(false);
  });

  it("keeps rendering when a required source is refused but left a body", () => {
    const state = derive({ required: [failed([{ id: 1 }])] });
    expect(state.ready).toBe(true);
    expect(state.blocked).toBe(false);
    // Old rows plus a banner, not an error card.
    expect(state.servingLastKnownGood).toBe(true);
    expect(state.failure?.status).toBe(429);
  });

  it("is blocked only when a required source failed with nothing to show", () => {
    const state = derive({ required: [failed()] });
    expect(state.blocked).toBe(true);
    expect(state.ready).toBe(false);
    expect(state.servingLastKnownGood).toBe(false);
  });

  it("is blocked when any one required source has nothing, even if another does", () => {
    expect(derive({ required: [ok(), failed()] }).blocked).toBe(true);
  });

  it("holds the first paint until optional sources settle, so a total does not jump", () => {
    expect(derive({ required: [ok()], optional: [undefined] }).ready).toBe(false);
    expect(derive({ required: [ok()], optional: [loading()] }).ready).toBe(false);
    expect(derive({ required: [ok()], optional: [ok()] }).ready).toBe(true);
  });

  it("lets optional sources stop gating once the widget has drawn once", () => {
    const state = derive({ required: [ok()], optional: [loading()], rendered: true });
    expect(state.ready).toBe(true);
  });

  it("draws anyway when an optional source fails, and says the total is short", () => {
    const state = derive({ required: [ok()], optional: [ok(), failed(), failed()] });
    expect(state.ready).toBe(true);
    expect(state.blocked).toBe(false);
    expect(state.missingOptional).toBe(2);
  });

  it("does not count an optional source that failed but kept its body", () => {
    expect(derive({ required: [ok()], optional: [failed([{ id: 2 }])] }).missingOptional).toBe(0);
  });

  it("reports a required source's failure ahead of an optional one's", () => {
    const requiredFailure = failed([{ id: 1 }]);
    const state = derive({ required: [requiredFailure], optional: [failed()] });
    expect(state.failure).toBe(requiredFailure.error);
  });

  it("has nothing to render when there are no sources at all", () => {
    expect(derive({ required: [] }).ready).toBe(false);
  });
});

/**
 * The record page's last resort: a copy something else already fetched.
 *
 * A by-id endpoint nobody has called is cold by definition, so when the API
 * refuses there is nothing to keep showing — unless the record itself is
 * already in hand under a different request, which on a page opened from a
 * list it almost always is.
 */
describe("heldRecordFor", () => {
  const links: Record<string, EntityLinkView[]> = {
    api: [
      {
        entity: "task",
        resource: "task",
        name: { one: "Task", many: "Tasks" },
        identity: "Id",
        title: ["Title"],
        ops: ["tasks_list", "tasks_get"],
        list: "tasks_list",
        references: [],
        labels: {},
      },
    ],
  };

  const widget = { entity: "task", sources: [{ connection: "api", op: "tasks_get", params: {} }] } as unknown as WidgetSpec;

  const loaded = () => {
    const records = new RecordIndex();
    records.ingest({
      connection: "api",
      op: "tasks_list",
      body: [{ Id: 5138849, Title: "Exhaust fan not working" }],
      plan: indexPlan(links),
    });
    return records;
  };

  const ask = (over: Partial<Parameters<typeof heldRecordFor>[0]> = {}) =>
    heldRecordFor({
      blocked: true,
      widget,
      row: { Id: 5138849 },
      links,
      connection: "api",
      records: loaded(),
      ...over,
    });

  it("finds the record the list already brought back", () => {
    expect(ask()).toMatchObject({ Title: "Exhaust fan not working" });
  });

  /*
   * The held copy may carry fewer fields than the endpoint would, so standing
   * in for a response that did arrive would make a whole record look partial.
   */
  it("stays out of the way when the pane has something to draw", () => {
    expect(ask({ blocked: false })).toBeUndefined();
  });

  it("returns nothing when this particular record was never seen", () => {
    expect(ask({ row: { Id: 999 } })).toBeUndefined();
  });

  it("returns nothing without a row, a connection, or a link map", () => {
    expect(ask({ row: undefined })).toBeUndefined();
    expect(ask({ connection: undefined })).toBeUndefined();
    expect(ask({ links: undefined })).toBeUndefined();
  });

  it("returns nothing when the record type has no identity to key on", () => {
    const noIdentity = { api: [{ ...links.api![0]!, identity: undefined }] };
    expect(ask({ links: noIdentity })).toBeUndefined();
  });

  /* One connection's records must never answer for another's. */
  it("does not cross connections", () => {
    expect(ask({ connection: "other" })).toBeUndefined();
  });
});
