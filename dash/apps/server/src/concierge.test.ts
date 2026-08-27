import type { ConciergeDraft } from "@freebirdai/dash-agent";
import { applyStep, newDraft } from "@freebirdai/dash-agent";
import {
  capabilityReportSchema,
  connectionSchema,
  dashboardSchema,
  type ConnectionSpec,
  type DashboardSpec,
} from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import {
  conciergeActions,
  lookUpEndpoint,
  type ConciergeOps,
} from "./chat/concierge-actions.js";
import { buildChatRegistry } from "./chat/registry.js";
import { buildConciergeContext } from "./concierge/context.js";
import { MemoryDraftStore, parseDraft } from "./concierge/store.js";
import { toJsonSchema } from "./llm.js";

/**
 * The concierge as the server exposes it.
 *
 * The question derivation is tested purely in `@freebirdai/dash-agent`; this covers the
 * seams that only exist here — the report-to-questions translation, the three
 * actions, and the guards that stop an answer being applied to the wrong
 * question or a credential being asked for through a tool argument.
 */

/* ── fixtures ──────────────────────────────────────────────────────────── */

const connection: ConnectionSpec = connectionSchema.parse({
  id: "acme",
  title: "Acme",
  kind: "rest",
  baseUrl: "https://api.example.com",
  ops: [
    { id: "list_things", title: "List things", path: "/things" },
    { id: "get_thing", title: "Get thing", path: "/things/{{param.thingId}}" },
    { id: "list_owners", title: "List owners", path: "/owners" },
  ],
});

const report = capabilityReportSchema.parse({
  connection: "acme",
  generatedAt: new Date("2026-08-01T00:00:00Z").toISOString(),
  opsFingerprint: "abc123",
  resources: [
    {
      id: "thing",
      title: "Thing",
      idField: "Id",
      labelField: "Name",
      listOp: "list_things",
      detailOp: "get_thing",
      detailParam: "thingId",
      verified: true,
    },
    { id: "owner", title: "Owner", idField: "OwnerId", listOp: "list_owners", verified: true },
  ],
  drillDowns: [
    {
      resource: "thing",
      title: "Thing",
      listOp: "list_things",
      detailOp: "get_thing",
      idField: "Id",
      detailParam: "thingId",
      sampled: true,
    },
  ],
  joins: [
    {
      from: "thing",
      to: "owner",
      title: "Thing → Owner",
      foreignField: "OwnerId",
      targetField: "OwnerId",
      filterParam: "ownerId",
      needsFanOut: false,
    },
  ],
  searchable: [{ op: "list_things", param: "q" }],
  shapes: {
    thing: {
      rowsPath: "$.data",
      rowCount: 4,
      schemaHash: "h1",
      fields: [
        { name: "Id", kinds: ["number"], distinct: 4 },
        { name: "Name", kinds: ["string"], distinct: 4 },
        { name: "Status", kinds: ["string"], distinct: 3 },
        { name: "Amount", kinds: ["number"], format: "minor_units", distinct: 4 },
        { name: "OwnerId", kinds: ["number"], distinct: 2 },
        { name: "OpenedAt", kinds: ["string"], format: "iso8601", distinct: 4 },
      ],
    },
    owner: {
      rowsPath: "$.data",
      rowCount: 2,
      schemaHash: "h2",
      fields: [
        { name: "OwnerId", kinds: ["number"], distinct: 2 },
        { name: "OwnerName", kinds: ["string"], distinct: 2 },
      ],
    },
  },
});

const emptyBoard = (): DashboardSpec =>
  dashboardSchema.parse({ id: "ops", title: "Ops", widgets: [], layout: { cells: [] } });

/** The actions, wired to an in-memory board and draft store. */
const wire = () => {
  const drafts = new MemoryDraftStore();
  let board = emptyBoard();
  /** Every connection the flow asked to read. Empty is the expected answer. */
  const reads: string[] = [];

  const ops: ConciergeOps = {
    readConnection: async (id) => {
      reads.push(id);
      return { ok: true };
    },
    context: buildConciergeContext({ connections: [connection], reports: [report] }),
    // No setup running when the turn began; the actions read the store live.
    draft: null,
    getDraft: () => drafts.get("ops"),
    putDraft: (draft) => drafts.put("ops", draft),
    clearDraft: () => drafts.clear("ops"),
    getDashboard: () => board,
    putDashboard: (spec) => void (board = spec),
  };

  const actions = conciergeActions(ops) ?? [];
  const action = (id: string) => actions.find((candidate) => candidate.id === id)!;

  return { ops, action, board: () => board, drafts, reads };
};

type StepPayload = {
  ready?: boolean;
  step?: { stepId: string; options: Array<{ value: string; recommended?: boolean }> } | null;
  widget?: { id: string; component: string } | null;
  controls?: Array<{ stepId: string; value: string[]; required: boolean }>;
  summary?: { widgetId: string; title: string };
  rejected?: Array<{ field: string; available: string[] }>;
  warnings?: readonly string[];
};

/* ── the report becomes questions ──────────────────────────────────────── */

describe("turning a capability report into questions", () => {
  const context = buildConciergeContext({ connections: [connection], reports: [report] });

  it("offers only endpoints that can be called with nothing", () => {
    const ids = context.ops.map((op) => op.id);
    expect(ids).toContain("list_things");
    expect(ids).toContain("list_owners");
    // Its path needs an id nobody has yet — it is reachable as a drill-down,
    // not as the start of a widget.
    expect(ids).not.toContain("get_thing");
  });

  it("maps a resource's sampled shape onto both of its endpoints", () => {
    expect(context.shapes["list_things"]?.fields.map((field) => field.name)).toContain("Status");
    // The detail endpoint returns one row of the same thing.
    expect(context.shapes["get_thing"]?.fields.map((field) => field.name)).toContain("Status");
  });

  it("carries no sampled values across, only the shape", () => {
    for (const shape of Object.values(context.shapes)) {
      for (const field of shape.fields) expect(field.samples).toEqual([]);
    }
  });

  it("states a join in op terms, with its price", () => {
    expect(context.joins).toHaveLength(1);
    expect(context.joins[0]).toMatchObject({
      fromOp: "list_things",
      toOp: "list_owners",
      leftField: "OwnerId",
      rightField: "OwnerId",
      fetch: { mode: "filtered", param: "ownerId" },
    });
  });

  it("drops a fan-out join with nowhere to put the key", () => {
    const noFilter = capabilityReportSchema.parse({
      ...report,
      // `owner` has no detailOp, so a per-row call has no input to feed.
      joins: [{ ...report.joins[0]!, filterParam: undefined, needsFanOut: true }],
    });
    const built = buildConciergeContext({ connections: [connection], reports: [noFilter] });
    expect(built.joins).toEqual([]);
  });

  it("offers a fan-out when the other side has a by-id endpoint to call", () => {
    const reversed = capabilityReportSchema.parse({
      ...report,
      joins: [
        {
          from: "owner",
          to: "thing",
          title: "Owner → Thing",
          foreignField: "OwnerId",
          targetField: "Id",
          needsFanOut: true,
        },
      ],
    });
    const built = buildConciergeContext({ connections: [connection], reports: [reversed] });
    expect(built.joins[0]?.fetch).toMatchObject({ mode: "perRow", param: "thingId" });
  });

  it("keeps a connection with no report askable, so the read can be offered", () => {
    const built = buildConciergeContext({ connections: [connection], reports: [] });
    expect(built.connections).toHaveLength(1);
    expect(built.ops.length).toBeGreaterThan(0);
    expect(built.shapes).toEqual({});
  });
});

/* ── the actions ───────────────────────────────────────────────────────── */

describe("the setup actions", () => {
  it("keeps every tool schema inside the flat subset", () => {
    const { action } = wire();
    for (const id of ["start_setup", "answer_step", "revise_setup", "confirm_setup"]) {
      expect(() => toJsonSchema(action(id).schema as never)).not.toThrow();
    }
  });

  it("confirms before it writes, and not before it thinks", () => {
    const { action } = wire();
    /*
     * Only the step that writes asks first.
     *
     * Starting, answering and revising all change a draft held for this
     * session — no disk, no requests, and the live preview is what the user is
     * actually judging. A card in front of each of those would turn describing
     * a widget into a negotiation.
     */
    expect(action("start_setup").requiresConfirmation).toBe("none");
    // Recording an answer changes a draft held for this session and nothing
    // else — no spec, no request, no disk.
    expect(action("answer_step").requiresConfirmation).toBe("none");
    // Same reasoning: it changes a session draft and the preview is what the
    // user is judging, so a card per adjustment would only be in the way.
    expect(action("revise_setup").requiresConfirmation).toBe("none");
    expect(action("confirm_setup").requiresConfirmation).toBe("preview");
  });

  it("asks the first question the moment a setup starts", async () => {
    const { action } = wire();
    const state = (await action("start_setup").handler(
      { intent: "show me the things" },
      {} as never,
    )) as StepPayload;

    expect(state.ready).toBe(false);
    // Which endpoint is the one thing the assistant cannot work out from a
    // sentence alone, so it is still the first blocking decision.
    expect(state.step?.stepId).toBe("endpoint");
    expect(state.step?.options.map((option) => option.value)).toContain("list_things");
  });

  it("refuses an answer to a question that is no longer the current one", async () => {
    const { action } = wire();
    await action("start_setup").handler({ intent: "things" }, {} as never);

    const refusal = await action("answer_step").authorize?.(
      { stepId: "role:columns", values: ["Name"], skip: false } as never,
      {} as never,
    );
    expect(refusal).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses to answer when no setup is running", async () => {
    const { action } = wire();
    expect(
      await action("answer_step").authorize?.(
        { stepId: "endpoint", values: ["list_things"], skip: false } as never,
        {} as never,
      ),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses to confirm a setup that still has questions in it", async () => {
    const { action } = wire();
    await action("start_setup").handler({ intent: "things" }, {} as never);
    expect(await action("confirm_setup").authorize?.({} as never, {} as never)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("proposes a whole widget in one call and puts it on the board", async () => {
    const { action, board, ops } = wire();
    await action("start_setup").handler({ intent: "things and what they cost" }, {} as never);

    const state = (await action("revise_setup").handler(
      {
        endpoint: "list_things",
        component: "bar",
        roles: [
          { role: "category", fields: ["Status"] },
          { role: "value", fields: ["Amount"] },
        ],
        title: "Amount by status",
      },
      {} as never,
    )) as StepPayload;

    expect(state.rejected).toEqual([]);
    expect(state.ready).toBe(true);
    // Nothing left to ask, and a spec the card can render live.
    expect(state.step).toBeNull();
    expect(state.widget?.component).toBe("bar");

    expect(await action("confirm_setup").authorize?.({} as never, {} as never)).toBe(true);
    await action("confirm_setup").handler({}, {} as never);

    expect(board().widgets).toHaveLength(1);
    expect(board().widgets[0]?.title).toBe("Amount by status");
    expect(await ops.getDraft()).toBeNull();
  });

  it("offers a control for every decision, including the ones it did not ask about", async () => {
    const { action } = wire();
    await action("start_setup").handler({ intent: "things" }, {} as never);
    const state = (await action("revise_setup").handler(
      {
        endpoint: "list_things",
        component: "table",
        roles: [{ role: "columns", fields: ["Name", "Status"] }],
      },
      {} as never,
    )) as StepPayload;

    const byId = new Map((state.controls ?? []).map((control) => [control.stepId, control]));
    expect(byId.get("component")?.value).toEqual(["table"]);
    expect(byId.get("role:columns")?.value).toEqual(["Name", "Status"]);
    // Never asked as a question in this mode, but present as something to turn on.
    expect(byId.has("drilldown")).toBe(true);
    expect(byId.get("drilldown")?.required).toBe(false);
  });

  it("hands an invented field back rather than absorbing it", async () => {
    const { action } = wire();
    await action("start_setup").handler({ intent: "things" }, {} as never);
    const state = (await action("revise_setup").handler(
      {
        endpoint: "list_things",
        component: "bar",
        roles: [{ role: "category", fields: ["Vacancy"] }],
      },
      {} as never,
    )) as StepPayload;

    expect(state.rejected?.[0]?.field).toBe("Vacancy");
    expect(state.rejected?.[0]?.available).toContain("Status");
    expect(state.ready).toBe(false);
  });

  it("refuses to revise when nothing is being built", async () => {
    const { action } = wire();
    expect(
      await action("revise_setup").authorize?.({} as never, {} as never),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("will not confirm an assisted draft that cannot be built", async () => {
    const { action, board } = wire();
    await action("start_setup").handler({ intent: "things" }, {} as never);
    await action("revise_setup").handler({ endpoint: "list_things" }, {} as never);

    expect(await action("confirm_setup").authorize?.({} as never, {} as never)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(board().widgets).toEqual([]);
  });

  it("declares the dashboard filter a search box needs, rather than writing a broken widget", async () => {
    const { action, board } = wire();
    await action("start_setup").handler({ intent: "things I can search" }, {} as never);

    await action("revise_setup").handler(
      {
        endpoint: "list_things",
        component: "table",
        roles: [{ role: "columns", fields: ["Name", "Status"] }],
        controls: ["endpointSearch"],
        title: "Things",
      },
      {} as never,
    );
    await action("confirm_setup").handler({}, {} as never);

    expect(board().params.filters.map((filter) => filter.key)).toContain("search");
    expect(board().widgets[0]?.source?.params).toMatchObject({ q: "{{param.search}}" });
  });
});

/* ── nothing sensitive travels through a tool argument ─────────────────── */

describe("what the setup will not accept", () => {
  it("takes no credential-shaped argument anywhere in its schemas", () => {
    const { action } = wire();
    const banned = /(key|secret|token|password|credential|authorization|bearer)/i;

    for (const id of ["start_setup", "answer_step", "revise_setup", "confirm_setup"]) {
      const schema = toJsonSchema(action(id).schema as never) as {
        properties?: Record<string, unknown>;
      };
      for (const name of Object.keys(schema.properties ?? {})) {
        expect(banned.test(name), `${id} accepts "${name}"`).toBe(false);
      }
    }
  });
});

/* ── the draft store ───────────────────────────────────────────────────── */

describe("where a half-finished setup lives", () => {
  const draft = (id: string): ConciergeDraft => newDraft(id, "something");

  it("hands back what it was given", async () => {
    const store = new MemoryDraftStore();
    await store.put("a", draft("d1"));
    expect((await store.get("a"))?.id).toBe("d1");
    expect(await store.get("b")).toBeNull();
  });

  it("forgets a draft nobody came back to", async () => {
    let now = 0;
    const store = new MemoryDraftStore(() => now);
    await store.put("a", draft("d1"));
    now = 7 * 60 * 60 * 1000;
    expect(await store.get("a")).toBeNull();
  });

  it("keeps one scope's draft out of another's", async () => {
    const store = new MemoryDraftStore();
    await store.put("a", draft("d1"));
    await store.put("b", draft("d2"));
    await store.clear("a");
    expect(await store.get("a")).toBeNull();
    expect((await store.get("b"))?.id).toBe("d2");
  });

  it("refuses a stored blob that is not a draft, rather than half-trusting it", () => {
    // Storage stops being this process's own memory the moment it is durable,
    // so what comes back is untrusted input.
    expect(parseDraft({ id: "d1", component: 42 })).toBeNull();
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft(newDraft("d1", "x"))?.id).toBe("d1");
  });
});

/* ── it reaches the model ──────────────────────────────────────────────── */

describe("what the assistant is told about a setup", () => {
  const registryWith = (draft: ConciergeDraft | null) => {
    const dashboard = emptyBoard();
    return buildChatRegistry({
      dashboard,
      reports: [report],
      board: { getDashboard: () => dashboard, putDashboard: () => {} },
      concierge: {
        context: buildConciergeContext({ connections: [connection], reports: [report] }),
        draft,
        getDraft: async () => draft,
        putDraft: async () => {},
        clearDraft: async () => {},
        getDashboard: () => dashboard,
        putDashboard: () => {},
        readConnection: async () => ({ ok: true }),
      },
    });
  };

  const roster = (registry: ReturnType<typeof registryWith>) =>
    (registry.list()[0]?.knowledge ?? []).map((item) => item.text).join("\n");

  it("names every endpoint, and not one of their fields", () => {
    const text = roster(registryWith(null));
    expect(text).toContain("start_setup");

    /*
     * Names, always. The catalogue that used to live here carried names *and*
     * fields, which measured 44.7 KB complete against a 24 KB budget — so what
     * shipped was truncated at forty and the assistant treated that as the
     * whole API. Removing it fixed the size and created a worse problem:
     * asked which endpoints covered listings and applications, the assistant
     * said it had 59 of them but "I don't have the detailed list in front of
     * me", and offered to build a widget instead of answering.
     *
     * Fields were the expensive half and they are what `look_up_endpoint`
     * fetches on demand. Names are cheap — 988 bytes for all 59 of Buildium's
     * — so they stay.
     */
    expect(text).toContain("List things");
    expect(text).toContain("List owners");
    expect(text).not.toContain("OwnerName");
    expect(text).not.toContain("OpenedAt");
    expect(text).toContain("look_up_endpoint");
  });

  it("names the connections and how much of each is readable", () => {
    // "Why can't I see X?" is unanswerable without this, and it is asked a lot.
    expect(roster(registryWith(null))).toContain("Acme");
  });

  it("does not grow with the number of fields an endpoint has", () => {
    const many = connectionSchema.parse({
      ...connection,
      ops: [
        // The two the report has shapes for, so both cases are comparing the
        // same "there is something to build" message.
        ...connection.ops,
        ...Array.from({ length: 200 }, (_, index) => ({
          id: `list_${index}`,
          title: `List number ${index}`,
          path: `/things/${index}`,
        })),
      ],
    });
    const board = emptyBoard();
    const big = buildChatRegistry({
      dashboard: board,
      reports: [report],
      board: { getDashboard: () => board, putDashboard: () => {} },
      concierge: {
        context: buildConciergeContext({ connections: [many], reports: [report] }),
        draft: null,
        getDraft: async () => null,
        putDraft: async () => {},
        clearDraft: async () => {},
        getDashboard: () => board,
        putDashboard: () => {},
        readConnection: async () => ({ ok: true }),
      },
    });

    /*
     * The roster tracks names, which are bounded and cheap, and never fields,
     * which are neither. Two hundred extra endpoints nobody has read add
     * nothing at all — an unread endpoint cannot be built from, so naming it
     * would be an offer that cannot be kept.
     */
    expect(Math.abs(roster(big).length - roster(registryWith(null)).length)).toBeLessThan(20);
  });

  it("hands over the material to choose from, not a question to relay", () => {
    const draft = newDraft("d1", "things", "assisted");
    const text = roster(registryWith(draft));

    expect(text).toContain("ENDPOINTS");
    expect(text).toContain("list_things");
    expect(text).toContain("revise_setup");
  });

  it("gives the field list once an endpoint is chosen, described by shape", () => {
    const context = buildConciergeContext({ connections: [connection], reports: [report] });
    const draft = applyStep(newDraft("d1", "things", "assisted"), "endpoint", ["list_things"], context);
    const text = roster(registryWith(draft));

    expect(text).toContain("FIELDS");
    expect(text).toContain("Status");
    expect(text).toContain("VIEWS");
  });

  it("tells it to ask about the data rather than reciting the field names", () => {
    const draft = newDraft("d1", "things", "assisted");
    const text = roster(registryWith(draft));
    expect(text).toContain("Never show them a list of field names");
    expect(text).toContain("Never invent a name");
  });

  it("stays well inside the prompt budget on a wide endpoint", () => {
    /*
     * The field list is the biggest thing handed to the model, and it grows
     * with the API rather than with anything this code controls. `knowledge`
     * is truncated at a character budget, so a runaway list would silently
     * push the widget roster — the one thing that must always survive — out of
     * the prompt.
     */
    const wide = capabilityReportSchema.parse({
      ...report,
      shapes: {
        thing: {
          rowsPath: "$.data",
          rowCount: 50,
          schemaHash: "wide",
          fields: Array.from({ length: 60 }, (_, index) => ({
            name: `AVeryLongFieldNameNumber${index}`,
            kinds: ["string"],
            distinct: 7,
          })),
        },
      },
    });

    const dashboard = emptyBoard();
    const context = buildConciergeContext({ connections: [connection], reports: [wide] });
    const draft = applyStep(newDraft("d1", "things", "assisted"), "endpoint", ["list_things"], context);
    const registry = buildChatRegistry({
      dashboard,
      reports: [wide],
      board: { getDashboard: () => dashboard, putDashboard: () => {} },
      concierge: {
        context,
        draft,
        getDraft: async () => draft,
        putDraft: async () => {},
        clearDraft: async () => {},
        getDashboard: () => dashboard,
        putDashboard: () => {},
        readConnection: async () => ({ ok: true }),
      },
    });

    const text = (registry.list()[0]?.knowledge ?? []).map((item) => item.text).join("\n");
    // The plugin is mounted with a 24k budget for the whole prompt.
    expect(text.length).toBeLessThan(8_000);
    expect(text).toContain("AVeryLongFieldNameNumber0");
  });

  it("registers no setup actions when there is nothing to build against", () => {
    const dashboard = emptyBoard();
    const registry = buildChatRegistry({
      dashboard,
      reports: [],
      board: { getDashboard: () => dashboard, putDashboard: () => {} },
    });
    const ids = (registry.list()[0]?.actions ?? []).map((action) => action.id);
    expect(ids).not.toContain("start_setup");
  });
});

/* ── looking things up without building anything ───────────────────────── */

describe("look_up_endpoint", () => {
  const lookUp = async (query: string) => {
    /*
     * Called directly, because it is no longer an action. An action's result
     * never returns to the conversation — the engine runs it as a confirmed
     * side effect — so a model calling one to answer a question announced the
     * lookup and then had nothing to say. This is a processing tool now, whose
     * result is fed back into the same turn.
     */
    return lookUpEndpoint(buildConciergeContext({ connections: [connection], reports: [report] }), {
      query,
    }) as {
      found: number;
      note?: string;
      endpoints?: Array<{ id: string; name: string; url: string | null; fields: string[] }>;
    };
  };

  it("answers a plain question about the data with fields and a URL", async () => {
    /*
     * The failure this exists for: asked which endpoints covered listings and
     * applications, the assistant said it could see 59 endpoints but not their
     * details, then offered to build a widget instead of answering. Detail is
     * now one call away and costs nothing until somebody asks.
     */
    const result = await lookUp("things");
    expect(result.found).toBeGreaterThan(0);
    expect(result.endpoints?.[0]?.id).toBe("list_things");
    expect(result.endpoints?.[0]?.fields).toContain("Status");
    expect(result.endpoints?.[0]?.url).toBe("/things");
  });

  it("matches an exact id, which is what a follow-up question uses", async () => {
    const result = await lookUp("list_owners");
    expect(result.endpoints?.[0]?.id).toBe("list_owners");
    expect(result.endpoints?.[0]?.fields).toContain("OwnerName");
  });

  it("treats a miss as an answer rather than a reason to keep looking", async () => {
    const result = await lookUp("spacecraft");
    expect(result.found).toBe(0);
    // The roster is the complete list, so nothing matching means nothing there.
    expect(result.note).toContain("cannot read that");
  });

  it("never offers an endpoint that has not been read", async () => {
    // `get_thing` needs a path parameter and carries no sampled shape.
    const result = await lookUp("get_thing");
    expect(result.found).toBe(0);
  });

  it("spends nothing — no connection is read to answer it", async () => {
    const { reads } = wire();
    await lookUp("things");
    expect(reads).toEqual([]);
  });

  it("is not an action, because an action's result never reaches the model", () => {
    const { action } = wire();
    expect(action("look_up_endpoint")).toBeUndefined();
  });
});
