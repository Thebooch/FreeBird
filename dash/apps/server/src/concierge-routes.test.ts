import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilityReportSchema,
  connectionSchema,
  dashboardSchema,
  type CapabilityReport,
  type ConnectionSpec,
} from "@freebirdai/dash-spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";

/**
 * Guided setup over HTTP, with no model anywhere in the picture.
 *
 * This is the "degrade to the deterministic wizard" path proven end to end: a
 * server built with no LLM at all still walks a whole widget out of a
 * capability report and writes it to the board. Every request here is served
 * from disk — if any of it reached an upstream API, the stub transport would
 * be the only thing answering and the shapes would be wrong.
 */

let dir: string;
let store: SpecStore;
let keys: KeyStore;

const connection: ConnectionSpec = connectionSchema.parse({
  id: "api",
  title: "Demo API",
  kind: "rest",
  baseUrl: "https://api.example.com",
  ops: [
    { id: "items", title: "Items", path: "/items", rowsPath: "$.data" },
    { id: "item", title: "Item", path: "/items/{{param.itemId}}" },
  ],
});

const report: CapabilityReport = capabilityReportSchema.parse({
  connection: "api",
  generatedAt: new Date("2026-08-01T00:00:00Z").toISOString(),
  opsFingerprint: "fp",
  resources: [
    {
      id: "item",
      title: "Item",
      idField: "Id",
      labelField: "Name",
      listOp: "items",
      detailOp: "item",
      detailParam: "itemId",
      verified: true,
    },
  ],
  drillDowns: [
    {
      resource: "item",
      title: "Item",
      listOp: "items",
      detailOp: "item",
      idField: "Id",
      detailParam: "itemId",
      sampled: true,
    },
  ],
  shapes: {
    item: {
      rowsPath: "$.data",
      rowCount: 5,
      schemaHash: "h",
      fields: [
        { name: "Id", kinds: ["number"], distinct: 5 },
        { name: "Name", kinds: ["string"], distinct: 5 },
        { name: "State", kinds: ["string"], distinct: 3 },
        { name: "Total", kinds: ["number"], format: "minor_units", distinct: 5 },
        { name: "CreatedAt", kinds: ["string"], format: "iso8601", distinct: 5 },
      ],
    },
  },
});

/** A server with no LLM configured — the whole point of these tests. */
const makeApp = () => buildServer({ store, keys, http: async (url) => ({ status: 200, text: "{}", url, header: () => null }) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-concierge-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
  keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));

  store.putConnection(connection);
  store.putReport(report);
  store.putDashboard(
    dashboardSchema.parse({ id: "ops", title: "Ops", widgets: [], layout: { cells: [] } }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type State = {
  active: boolean;
  /** True once nothing is left that blocks a widget being built. */
  ready?: boolean;
  /** Null once there is nothing left to ask. */
  step?: Step | null;
  remaining?: number;
  summary?: { title: string; component: string; requests: number; onOpen: number } | null;
  warnings?: string[];
  errors?: string[];
};

type Step = {
  stepId: string;
  question: string;
  multiple: boolean;
  skippable: boolean;
  freeText: boolean;
  options: Array<{ value: string; label: string; description: string | null; recommended: boolean }>;
};

describe("guided setup with no model at all", () => {
  it("reports nothing running until one is started", async () => {
    const app = makeApp();
    const idle = await app.inject({ method: "GET", url: "/api/concierge/ops" });
    expect(idle.json()).toEqual({ active: false });
  });

  it("asks its first question straight from the report", async () => {
    const app = makeApp();
    const started = await app.inject({
      method: "POST",
      url: "/api/concierge/ops/start",
      payload: { intent: "show me my items" },
    });

    const state = started.json() as State;
    expect(state.active).toBe(true);
    expect(state.step?.stepId).toBe("endpoint");
    // The by-id endpoint needs an id nobody has yet, so it is not a starting
    // point — it is reachable as a drill-down instead.
    expect(state.step?.options.map((option) => option.value)).toEqual(["items"]);
  });

  it("refuses an answer to a question that has moved on", async () => {
    const app = makeApp();
    await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} });

    const stale = await app.inject({
      method: "POST",
      url: "/api/concierge/ops/answer",
      payload: { stepId: "role:columns", values: ["Name"] },
    });

    expect(stale.statusCode).toBe(409);
    // The real state comes back with the refusal, so a stale card can redraw
    // rather than leaving the user stuck on a question nobody is asking.
    expect((stale.json() as State).step?.stepId).toBe("endpoint");
  });

  it("refuses to answer when nothing is in progress", async () => {
    const app = makeApp();
    const orphan = await app.inject({
      method: "POST",
      url: "/api/concierge/ops/answer",
      payload: { stepId: "endpoint", values: ["items"] },
    });
    expect(orphan.statusCode).toBe(409);
  });

  it("walks a whole widget and writes it to the board", async () => {
    const app = makeApp();
    let state = (
      await app.inject({
        method: "POST",
        url: "/api/concierge/ops/start",
        payload: { intent: "items and what they are worth" },
      })
    ).json() as State;

    const asked: string[] = [];
    for (let guard = 0; guard < 20 && state.step; guard++) {
      const step = state.step;
      asked.push(step.stepId);
      const pick = step.options.find((option) => option.recommended) ?? step.options[0];
      state = (
        await app.inject({
          method: "POST",
          url: "/api/concierge/ops/answer",
          payload: {
            stepId: step.stepId,
            values: pick ? [pick.value] : [],
            skip: !pick,
          },
        })
      ).json() as State;
    }

    expect(state.step).toBeNull();
    expect(state.ready).toBe(true);
    expect(state.summary?.title).toBeTruthy();
    // Both were derived from the report, not scripted into the flow.
    expect(asked).toContain("component");
    expect(asked).toContain("drilldown");

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/concierge/ops/confirm",
      payload: {},
    });
    expect(confirmed.statusCode).toBe(200);
    const widgetId = (confirmed.json() as { widgetId: string }).widgetId;

    const board = store.getDashboard("ops");
    expect(board?.widgets.map((widget) => widget.id)).toEqual([widgetId]);

    // The draft is spent, so the card renders itself away rather than showing
    // a summary for something already on the board.
    expect((await app.inject({ method: "GET", url: "/api/concierge/ops" })).json()).toEqual({
      active: false,
    });
  });

  it("will not confirm a setup with questions left in it", async () => {
    const app = makeApp();
    await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} });

    const early = await app.inject({
      method: "POST",
      url: "/api/concierge/ops/confirm",
      payload: {},
    });
    expect(early.statusCode).toBe(409);
    expect(store.getDashboard("ops")?.widgets).toEqual([]);
  });

  it("costs no upstream requests to design a whole widget", async () => {
    let calls = 0;
    const app = buildServer({
      store,
      keys,
      http: async (url) => {
        calls++;
        return { status: 200, text: "{}", url, header: () => null };
      },
    });

    let state = (
      await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} })
    ).json() as State;

    for (let guard = 0; guard < 20 && state.step; guard++) {
      const step = state.step;
      const pick = step.options.find((option) => option.recommended) ?? step.options[0];
      state = (
        await app.inject({
          method: "POST",
          url: "/api/concierge/ops/answer",
          payload: { stepId: step.stepId, values: pick ? [pick.value] : [], skip: !pick },
        })
      ).json() as State;
    }
    await app.inject({ method: "POST", url: "/api/concierge/ops/confirm", payload: {} });

    // Everything came off the capability report. The reads it stands on were
    // paid for once, when the connection was enumerated.
    expect(calls).toBe(0);
  });

  it("survives being abandoned and picked up again", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/start",
      payload: { intent: "items" },
    });
    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/answer",
      payload: { stepId: "endpoint", values: ["items"] },
    });

    // A reload asks the same question the server was already on.
    const resumed = (
      await app.inject({ method: "GET", url: "/api/concierge/ops" })
    ).json() as State;
    expect(resumed.active).toBe(true);
    expect(resumed.step?.stepId).toBe("component");
  });

  it("throws a setup away when asked to", async () => {
    const app = makeApp();
    await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} });
    await app.inject({ method: "DELETE", url: "/api/concierge/ops" });
    expect((await app.inject({ method: "GET", url: "/api/concierge/ops" })).json()).toEqual({
      active: false,
    });
  });

  it("offers a priced read for an endpoint nothing has been read from", async () => {
    // A connection with a second endpoint the report says nothing about.
    store.putConnection(
      connectionSchema.parse({
        ...connection,
        ops: [...connection.ops, { id: "others", title: "Others", path: "/others" }],
      }),
    );
    const app = makeApp();

    await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} });
    const state = (
      await app.inject({
        method: "POST",
        url: "/api/concierge/ops/answer",
        payload: { stepId: "endpoint", values: ["others"] },
      })
    ).json() as State;

    expect(state.step?.stepId).toBe("read");
    // The price is on the option, not discovered afterwards.
    expect(state.step?.options[0]?.label).toMatch(/request/);
  });

  it("spends nothing until the read is actually chosen", async () => {
    let calls = 0;
    store.putConnection(
      connectionSchema.parse({
        ...connection,
        ops: [...connection.ops, { id: "others", title: "Others", path: "/others" }],
      }),
    );
    const app = buildServer({
      store,
      keys,
      http: async (url) => {
        calls++;
        return { status: 200, text: JSON.stringify({ data: [] }), url, header: () => null };
      },
    });

    await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/answer",
      payload: { stepId: "endpoint", values: ["others"] },
    });
    // Seeing the offer is free. That is the whole point of pricing it up front.
    expect(calls).toBe(0);

    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/answer",
      payload: { stepId: "read", values: ["read"] },
    });
    expect(calls).toBeGreaterThan(0);
  });

  it("hands the key step to the panel instead of asking for one", async () => {
    // A connection whose credential is required and absent.
    store.putConnection(
      connectionSchema.parse({
        ...connection,
        id: "locked",
        auth: { type: "bearer", keyRef: "locked-key" },
        ops: [{ id: "locked_items", title: "Items", path: "/items" }],
      }),
    );
    const app = makeApp();

    await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/answer",
      payload: { stepId: "connection", values: ["locked"] },
    });
    const state = (
      await app.inject({
        method: "POST",
        url: "/api/concierge/ops/answer",
        payload: { stepId: "endpoint", values: ["locked_items"] },
      })
    ).json() as State;

    expect(state.step?.stepId).toBe("read");
    // No read on offer at all — it would spend requests collecting 401s.
    expect(state.step?.options.map((option) => option.value)).not.toContain("read");

    const answered = (
      await app.inject({
        method: "POST",
        url: "/api/concierge/ops/answer",
        payload: { stepId: "read", values: ["key"] },
      })
    ).json() as State & { open?: string };
    // The concierge opens the door to the credential panel and stops there.
    expect(answered.open).toBe("connections");
  });

  it("lets somebody back out of an unread endpoint", async () => {
    store.putConnection(
      connectionSchema.parse({
        ...connection,
        ops: [...connection.ops, { id: "others", title: "Others", path: "/others" }],
      }),
    );
    const app = makeApp();

    await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} });
    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/answer",
      payload: { stepId: "endpoint", values: ["others"] },
    });
    const back = (
      await app.inject({
        method: "POST",
        url: "/api/concierge/ops/answer",
        payload: { stepId: "read", values: ["other"] },
      })
    ).json() as State;

    expect(back.step?.stepId).toBe("endpoint");
  });

  it("says there is nothing connected rather than going quiet", async () => {
    const bare = new SpecStore(
      join(dir, "d2"),
      join(dir, "c2"),
      join(dir, "r2"),
    );
    bare.putDashboard(
      dashboardSchema.parse({ id: "ops", title: "Ops", widgets: [], layout: { cells: [] } }),
    );
    const app = buildServer({
      store: bare,
      keys,
      http: async (url) => ({ status: 200, text: "{}", url, header: () => null }),
    });

    const state = (
      await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} })
    ).json() as State;
    expect(state.step?.stepId).toBe("connect");
    expect(state.step?.options[0]?.description).toContain("never in this conversation");
  });

  it("builds the whole widget in one call and previews it", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/start",
      payload: { intent: "my items and what they cost", mode: "assisted" },
    });

    const state = (
      await app.inject({
        method: "POST",
        url: "/api/concierge/ops/revise",
        payload: {
          endpoint: "items",
          component: "bar",
          roles: { category: ["State"], value: ["Total"] },
          title: "Cost by state",
        },
      })
    ).json() as State & { widget?: { id: string; component: string } | null; rejected?: unknown[] };

    expect(state.rejected).toEqual([]);
    expect(state.ready).toBe(true);
    // Nothing left to ask, and a real spec to render — which is the preview.
    expect(state.step).toBeNull();
    expect(state.widget?.component).toBe("bar");

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/concierge/ops/confirm",
      payload: {},
    });
    expect(confirmed.statusCode).toBe(200);
    expect(store.getDashboard("ops")?.widgets).toHaveLength(1);
  });

  it("hands back a field nobody offered rather than absorbing it", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/start",
      payload: { intent: "items", mode: "assisted" },
    });

    const state = (
      await app.inject({
        method: "POST",
        url: "/api/concierge/ops/revise",
        payload: {
          endpoint: "items",
          component: "bar",
          roles: { category: ["Vacancy"], value: ["Total"] },
        },
      })
    ).json() as State & { rejected?: Array<{ value: string; available: string[] }> };

    expect(state.rejected?.[0]?.value).toBe("Vacancy");
    expect(state.rejected?.[0]?.available).toContain("State");
    // The widget is not buildable, so no preview is claimed for it.
    expect(state.ready).toBe(false);
  });

  it("will not confirm an assisted draft that cannot be built", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/start",
      payload: { intent: "items", mode: "assisted" },
    });
    await app.inject({
      method: "POST",
      url: "/api/concierge/ops/revise",
      payload: { endpoint: "items" },
    });

    const early = await app.inject({
      method: "POST",
      url: "/api/concierge/ops/confirm",
      payload: {},
    });
    expect(early.statusCode).toBe(409);
    expect(store.getDashboard("ops")?.widgets).toEqual([]);
  });

  it("keeps one board's setup out of another's", async () => {
    const app = makeApp();
    store.putDashboard(
      dashboardSchema.parse({ id: "other", title: "Other", widgets: [], layout: { cells: [] } }),
    );

    await app.inject({ method: "POST", url: "/api/concierge/ops/start", payload: {} });
    expect((await app.inject({ method: "GET", url: "/api/concierge/other" })).json()).toEqual({
      active: false,
    });
  });
});

/**
 * The fields a patch may carry, checked against the schema that parses it.
 *
 * Zod strips what it has not been told about, so a patch field the schema
 * omits arrives as a no-op that reports success. That has happened once
 * already — `joinWith` was silently dropped for a release, and it looked like
 * a revise that simply did nothing. This is the guard.
 */
describe("the revise schema declares every patch field", () => {
  it("keeps the ones the machine reads", async () => {
    const { reviseSchema } = await import("./routes/concierge.js");
    const declared = Object.keys(reviseSchema.shape);
    for (const field of [
      "shape",
      "seriesWith",
      "offerSeries",
      "measure",
      "groupBy",
      "joinWith",
      "offer",
      "choice",
      "model",
    ]) {
      expect(declared).toContain(field);
    }
  });
});
