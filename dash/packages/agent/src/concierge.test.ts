import { describe, expect, it } from "vitest";
import { buildAll, buildFromDraft } from "./concierge/build.js";
import {
  applyAnswer,
  newDraft,
  partCount,
  partView,
  partsOf,
  skipStep,
  withPart,
} from "./concierge/draft.js";
import {
  allSteps,
  allStepsAcross,
  applyStep,
  applyStepAcross,
  skipStepAcross,
  emptyContext,
  extraFieldOptions,
  fieldPool,
  nextStep,
  preferredForRole,
  nextStepAcross,
  readiness,
  readinessAcross,
  remainingSteps,
  settle,
  valueOfAcross,
  viewOptions,
  type ConciergeContext,
  type Step,
} from "./concierge/steps.js";
import { revise } from "./concierge/revise.js";
import { inferShape } from "./infer.js";
import { executeWidget } from "@freebirdai/dash-runtime";
import { resolveRange } from "@freebirdai/dash-spec";

/**
 * The concierge, driven with no model and no network.
 *
 * That is the whole point of the pure step machine: if this file needs a
 * fixture of an LLM response to test the conversation, the model has ended up
 * deciding something it should not have.
 */

/* ── three deliberately different APIs ─────────────────────────────────── */

/**
 * Flat collection, ISO dates, readable names. The easy case.
 */
const FLAT = {
  data: [
    { id: 1, name: "Alpha", status: "active", amount: 1250, createdAt: "2026-01-04T09:00:00Z" },
    { id: 2, name: "Beta", status: "overdue", amount: 400, createdAt: "2026-02-11T09:00:00Z" },
    { id: 3, name: "Gamma", status: "active", amount: 980, createdAt: "2026-03-02T09:00:00Z" },
    { id: 4, name: "Delta", status: "pending", amount: 15, createdAt: "2026-03-20T09:00:00Z" },
  ],
};

/**
 * Nested rows, unix seconds, and a foreign key. Different in every way the
 * first one is not.
 */
const NESTED = {
  response: {
    items: [
      { key: "a1", ownerRef: 77, opened: 1_770_000_000, total: 4210, tier: "gold" },
      { key: "a2", ownerRef: 78, opened: 1_772_000_000, total: 90, tier: "silver" },
      { key: "a3", ownerRef: 77, opened: 1_774_000_000, total: 3300, tier: "gold" },
    ],
  },
};

/**
 * Names that mean nothing. If a rule reads vocabulary rather than shape, this
 * is where it stops working.
 */
const OPAQUE = {
  rows: [
    { f1: "x7", f2: 12, f3: "2026-01-01T00:00:00Z", f4: true },
    { f1: "q2", f2: 44, f3: "2026-01-05T00:00:00Z", f4: false },
    { f1: "z9", f2: 8, f3: "2026-01-09T00:00:00Z", f4: true },
  ],
};

const OWNERS = {
  data: [
    { ownerId: 77, ownerName: "North", region: "west" },
    { ownerId: 78, ownerName: "South", region: "east" },
  ],
};

const contextFor = (
  shapes: Record<string, unknown>,
  extra: Partial<ConciergeContext> = {},
): ConciergeContext => ({
  ...emptyContext,
  connections: [{ id: "api", title: "The API" }],
  ops: Object.keys(shapes).map((op) => ({ id: op, title: op, connection: "api" })),
  shapes: Object.fromEntries(
    Object.entries(shapes).map(([op, body]) => [op, inferShape(body)]),
  ),
  ...extra,
});

/** Answer every question with its recommended option, or the first one. */
const runToCompletion = (
  context: ConciergeContext,
  intent = "show me the thing",
): { steps: Step[]; draft: ReturnType<typeof newDraft> } => {
  const steps: Step[] = [];
  let draft = newDraft("d1", intent);

  for (let guard = 0; guard < 40; guard++) {
    const step = nextStep(draft, context);
    if (!step) break;
    steps.push(step);
    const pick = step.options.find((option) => option.recommended) ?? step.options[0];
    if (!pick) {
      draft = skipStep(draft, step.id);
      continue;
    }
    draft = applyStep(draft, step.id, [pick.value], context);
  }

  return { steps, draft };
};

/* ── the conversation ──────────────────────────────────────────────────── */

describe("the step machine", () => {
  it("says there is nothing connected rather than ending in silence", () => {
    // It used to return null here, which put no card on screen at all — read
    // by a user as the assistant failing rather than as a missing prerequisite.
    const step = nextStep(newDraft("d"), emptyContext);
    expect(step?.id).toBe("connect");
    expect(step?.options[0]?.description).toContain("never in this conversation");
  });

  it("does not ask which API when there is only one", () => {
    const context = contextFor({ list: FLAT });
    expect(nextStep(newDraft("d"), context)?.id).toBe("endpoint");
  });

  it("asks which API when there are several", () => {
    const context: ConciergeContext = {
      ...contextFor({ list: FLAT }),
      connections: [
        { id: "api", title: "The API" },
        { id: "other", title: "Another" },
      ],
    };
    const step = nextStep(newDraft("d"), context);
    expect(step?.id).toBe("connection");
    expect(step?.options.map((option) => option.value)).toEqual(["api", "other"]);
  });

  it("offers a priced read for an endpoint nothing has been read from", () => {
    const context: ConciergeContext = {
      ...emptyContext,
      connections: [{ id: "api", title: "The API" }],
      ops: [{ id: "list", title: "list", connection: "api" }],
      readPlans: [
        {
          connection: "api",
          requests: 36,
          estimatedMs: 5000,
          alreadyRead: false,
          stale: false,
          needsKey: false,
        },
      ],
    };
    const draft = applyAnswer(newDraft("d"), "endpoint", ["list"]);
    const step = nextStep(draft, context);

    expect(step?.id).toBe("read");
    // The price is on the button, not in a footnote after the fact.
    expect(step?.options[0]?.label).toContain("36 request");
    expect(step?.help).toContain("charges per request");
  });

  it("walks a whole widget with no model at all", () => {
    const context = contextFor({ list: FLAT });
    const { steps, draft } = runToCompletion(context);
    const ids = steps.map((step) => step.id);

    expect(ids[0]).toBe("endpoint");
    expect(ids).toContain("component");
    expect(ids.some((id) => id.startsWith("role:"))).toBe(true);
    expect(ids.at(-1)).toBe("title");
    expect(draft.component).toBeTruthy();
    expect(nextStep(draft, context)).toBeNull();
  });

  it("never asks the same question twice", () => {
    const context = contextFor({ list: FLAT });
    const { steps } = runToCompletion(context);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
  });

  it("re-asks the view when a different endpoint is chosen", () => {
    const context = contextFor({ list: FLAT, other: OPAQUE });
    let draft = applyStep(newDraft("d"), "endpoint", ["list"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["name"], context);

    draft = applyStep(draft, "endpoint", ["other"], context);
    expect(draft.component).toBeUndefined();
    expect(draft.roles).toEqual({});
    expect(nextStep(draft, context)?.id).toBe("component");
  });

  it("skips the drill-down question when no endpoint offers one", () => {
    const context = contextFor({ list: FLAT });
    const { steps } = runToCompletion(context);
    expect(steps.map((step) => step.id)).not.toContain("drilldown");
  });

  it("asks it when one does, and binds the record to the row's identity", () => {
    const context = contextFor(
      { list: FLAT, byId: FLAT.data[0]! },
      {
        drillDowns: [
          {
            resource: "thing",
            title: "Thing",
            listOp: "list",
            detailOp: "byId",
            idField: "id",
            detailParam: "thingId",
          },
        ],
      },
    );

    let draft = applyStep(newDraft("d"), "endpoint", ["list"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["name", "status"], context);
    draft = applyStep(draft, "drilldown", ["byId"], context);

    expect(draft.drilldown).toEqual({
      op: "byId",
      param: "thingId",
      idField: "id",
      // All empty here on purpose. This step records only that clicking a row
      // opens the record; which fields it shows, how they group and which
      // related collections sit beside it are judgements the detail pass makes
      // later.
      fields: [],
      groups: [],
      sections: [],
    });
  });

  it("ignores a drill-down answer that was never on offer", () => {
    const context = contextFor({ list: FLAT });
    const draft = applyStep(
      applyStep(newDraft("d"), "endpoint", ["list"], context),
      "drilldown",
      ["somewhere-else"],
      context,
    );
    expect(draft.drilldown).toBeUndefined();
  });
});

/* ── reading an API ────────────────────────────────────────────────────── */

describe("the read offer", () => {
  const withPlan = (plan: Partial<ConciergeContext["readPlans"][number]>): ConciergeContext => ({
    ...emptyContext,
    connections: [{ id: "api", title: "The API" }],
    ops: [
      { id: "list", title: "list", connection: "api" },
      { id: "other", title: "other", connection: "api" },
    ],
    readPlans: [
      {
        connection: "api",
        requests: 12,
        estimatedMs: 4000,
        alreadyRead: false,
        stale: false,
        needsKey: false,
        ...plan,
      },
    ],
  });

  const atUnreadEndpoint = (context: ConciergeContext) =>
    nextStep(applyAnswer(newDraft("d"), "endpoint", ["list"]), context);

  it("never offers to read an API that has no key", () => {
    const step = atUnreadEndpoint(withPlan({ needsKey: true }));
    expect(step?.id).toBe("read");
    // Reading without a credential spends requests to collect 401s.
    expect(step?.options.map((option) => option.value)).not.toContain("read");
    expect(step?.options[0]?.value).toBe("key");
  });

  it("sends the key step to the panel that handles credentials", () => {
    const step = atUnreadEndpoint(withPlan({ needsKey: true }));
    expect(step?.help).toContain("not here");
  });

  it("says so when the API has changed since it was last read", () => {
    expect(atUnreadEndpoint(withPlan({ stale: true }))?.question).toContain("has changed");
  });

  it("does not suggest re-reading something that already came back empty", () => {
    const step = atUnreadEndpoint(withPlan({ alreadyRead: true }));
    expect(step?.question).toContain("returned nothing");
    // Re-reading is offered but never recommended — the same requests would
    // buy the same silence.
    const again = step?.options.find((option) => option.value === "read");
    expect(again?.recommended).toBeUndefined();
  });

  it("lets somebody back out to the endpoint list", () => {
    const context = withPlan({});
    let draft = applyAnswer(newDraft("d"), "endpoint", ["list"]);
    expect(nextStep(draft, context)?.options.map((o) => o.value)).toContain("other");

    draft = applyStep(draft, "read", ["other"], context);
    expect(draft.op).toBeUndefined();
    expect(nextStep(draft, context)?.id).toBe("endpoint");
  });

  it("does not mark itself answered, so a failed read asks again", () => {
    const context = withPlan({});
    const draft = applyStep(
      applyAnswer(newDraft("d"), "endpoint", ["list"]),
      "read",
      ["read"],
      context,
    );
    // Nothing about the draft changed; the world has to change instead.
    expect(draft.answered).not.toContain("read");
    expect(nextStep(draft, context)?.id).toBe("read");
  });

  it("moves straight on once the read has happened", () => {
    const context = withPlan({});
    const read: ConciergeContext = {
      ...context,
      shapes: { list: inferShape(FLAT) },
    };
    const draft = applyAnswer(newDraft("d"), "endpoint", ["list"]);
    expect(nextStep(draft, read)?.id).toBe("component");
  });

  it("does not invent a question count it cannot know", () => {
    // The walk that estimates the remaining path cannot answer an effect step,
    // so it stops there rather than spinning until its guard trips and
    // reporting a number pulled out of the loop bound.
    const context = withPlan({});
    const draft = applyAnswer(newDraft("d"), "endpoint", ["list"]);
    expect(remainingSteps(draft, context)).toBe(1);
  });

  it("says nothing when there is no plan to price it with", () => {
    // No estimate means no honest offer, and a card with no price on it is the
    // thing this whole flow exists to avoid.
    const context: ConciergeContext = { ...withPlan({}), readPlans: [] };
    expect(atUnreadEndpoint(context)).toBeNull();
  });
});

/* ── what gets offered ─────────────────────────────────────────────────── */

describe("the options", () => {
  it("only offers views the fields can actually fill", () => {
    // Nothing numeric, so a stat has no headline number to show.
    const fields = [{ name: "name", kinds: ["string"] }];
    const ids = viewOptions(fields).map((option) => option.value);
    expect(ids).toContain("table");
    expect(ids).not.toContain("stat");
  });

  it("recommends something other than a table when something else fits", () => {
    const shape = inferShape(FLAT);
    const recommended = viewOptions(shape.fields).find((option) => option.recommended);
    expect(recommended).toBeTruthy();
    expect(recommended?.value).not.toBe("table");
  });

  it("marks exactly one option as recommended", () => {
    const context = contextFor({ list: FLAT });
    const { steps } = runToCompletion(context);
    for (const step of steps) {
      const recommended = step.options.filter((option) => option.recommended);
      expect(recommended.length, `${step.id} recommended ${recommended.length}`).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("prefers a real date for a time role over a number that merely could be one", () => {
    const shape = inferShape(FLAT);
    const role = {
      role: "time",
      accepts: ["temporal", "numeric"] as const,
      required: true,
      description: "time",
    };
    expect(preferredForRole({ ...role, accepts: [...role.accepts] }, [...shape.fields])?.name).toBe(
      "createdAt",
    );
  });

  it("prefers a measure over an identifier for a numeric role", () => {
    const shape = inferShape(FLAT);
    const numeric = shape.fields.filter((field) => field.kinds.includes("number"));
    const preferred = preferredForRole(
      { role: "value", accepts: ["numeric"], required: true, description: "n" },
      numeric,
    );
    expect(preferred?.name).not.toBe("id");
  });

  it("explains a field by its shape, never by what it might mean", () => {
    const context = contextFor({ list: FLAT });
    const draft = applyStep(
      applyStep(newDraft("d"), "endpoint", ["list"], context),
      "component",
      ["table"],
      context,
    );
    const step = nextStep(draft, context);
    const status = step?.options.find((option) => option.value === "status");
    expect(status?.description).toContain("3 distinct values");
  });

  it("does not offer a field the widget already shows as an extra", () => {
    const shape = inferShape(FLAT);
    const offers = extraFieldOptions(shape.fields, new Set(["name", "amount"]));
    expect(offers.map((option) => option.value)).not.toContain("name");
    expect(offers.map((option) => option.value)).not.toContain("amount");
  });
});

/* ── the join ──────────────────────────────────────────────────────────── */

describe("joining a second endpoint", () => {
  const joined = (mode: "filtered" | "perRow"): ConciergeContext =>
    contextFor(
      { accounts: NESTED, owners: OWNERS },
      {
        joins: [
          {
            id: "accounts-owners",
            fromOp: "accounts",
            toOp: "owners",
            title: "Accounts → Owners",
            leftField: "ownerRef",
            rightField: "ownerId",
            fetch:
              mode === "filtered"
                ? { mode: "filtered", param: "ownerId" }
                : { mode: "perRow", param: "ownerId", maxRows: 25 },
          },
        ],
      },
    );

  it("prices the offer in the option itself", () => {
    const context = joined("perRow");
    const draft = applyStep(newDraft("d"), "endpoint", ["accounts"], context);
    const step = nextStep(draft, context);

    expect(step?.id).toBe("join");
    expect(step?.skippable).toBe(true);
    expect(step?.options[0]?.description).toContain("one request per row");
    // Nothing that costs a request per row is ever the suggested answer.
    expect(step?.options[0]?.recommended).toBeUndefined();
  });

  it("recommends the cheap one", () => {
    const context = joined("filtered");
    const draft = applyStep(newDraft("d"), "endpoint", ["accounts"], context);
    const step = nextStep(draft, context);
    expect(step?.options[0]?.recommended).toBe(true);
    expect(step?.options[0]?.description).toContain("One extra request");
  });

  it("offers the joined columns under the names the rows will carry", () => {
    const context = joined("filtered");
    let draft = applyStep(newDraft("d"), "endpoint", ["accounts"], context);
    draft = applyStep(draft, "join", ["accounts-owners"], context);

    const names = fieldPool(draft, context).map((field) => field.name);
    expect(names).toContain("tier");
    // `runPlan` prefixes every right-hand column, unconditionally.
    expect(names).toContain("owners_ownerName");
    expect(names).not.toContain("ownerName");
  });

  it("reopens the view question, because the field pool just changed", () => {
    const context = joined("filtered");
    let draft = applyStep(newDraft("d"), "endpoint", ["accounts"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "join", ["accounts-owners"], context);
    expect(draft.component).toBeUndefined();
    expect(nextStep(draft, context)?.id).toBe("component");
  });

  it("can be declined, and then never asked again", () => {
    const context = joined("filtered");
    let draft = applyStep(newDraft("d"), "endpoint", ["accounts"], context);
    draft = skipStep(draft, "join");
    expect(nextStep(draft, context)?.id).toBe("component");
    expect(draft.join).toBeUndefined();
  });

  it("builds a widget the spec accepts, and says what a join can do to a total", () => {
    const context = joined("filtered");
    let draft = applyStep(newDraft("d"), "endpoint", ["accounts"], context);
    draft = applyStep(draft, "join", ["accounts-owners"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["key", "owners_ownerName"], context);
    draft = applyAnswer(draft, "title", ["Accounts and owners"]);

    const result = buildFromDraft(draft, context);
    expect(result.errors).toEqual([]);
    expect(result.widget?.sources).toHaveLength(2);
    expect(result.widget?.combine).toMatchObject({
      op: "join",
      left: "accounts",
      right: "owners",
      on: { left: "ownerRef", right: "ownerId" },
    });
    expect(result.warnings.join(" ")).toContain("appears several times");
  });

  it("wires the per-row call to the input it feeds, and reports the cap", () => {
    const context = joined("perRow");
    let draft = applyStep(newDraft("d"), "endpoint", ["accounts"], context);
    draft = applyStep(draft, "join", ["accounts-owners"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["key"], context);
    draft = applyAnswer(draft, "title", ["Accounts and owners"]);

    const result = buildFromDraft(draft, context);
    expect(result.errors).toEqual([]);
    expect(result.widget?.sources[1]?.fanOut).toMatchObject({
      from: "accounts",
      field: "ownerRef",
      as: "ownerId",
      maxRows: 25,
    });
    expect(result.authored?.cost.requests).toBe(26);
    expect(result.warnings.join(" ")).toContain("once per row");
  });
});

/* ── the build ─────────────────────────────────────────────────────────── */

describe("building the answers into a widget", () => {
  it("produces a widget the spec accepts", () => {
    const context = contextFor({ list: FLAT });
    const { draft } = runToCompletion(context);
    const result = buildFromDraft(draft, context);

    expect(result.errors).toEqual([]);
    expect(result.widget).toBeTruthy();
    expect(result.authored?.source).toBe("chat");
    expect(result.authored?.why.length).toBeGreaterThan(0);
  });

  /*
   * Which model designed a widget, recorded on the widget.
   *
   * The actions route to different models now, so two widgets on one board can
   * have been built by different ones — and "why did this one bind the wrong
   * field" is not answerable without knowing which. Absent when nobody's model
   * chose anything, which is the honest answer rather than a gap.
   */
  it("records the model that proposed the setup", () => {
    const context = contextFor({ list: FLAT });
    const { draft } = runToCompletion(context);
    const at = new Date("2026-08-26T10:00:00.000Z");

    const anonymous = buildFromDraft(draft, context, { now: () => at });
    expect(anonymous.widget?.producedBy).toBeUndefined();

    const proposed = buildFromDraft({ ...draft, model: "claude-sonnet-5" }, context, {
      now: () => at,
    });
    expect(proposed.widget?.producedBy).toEqual({
      model: "claude-sonnet-5",
      at: "2026-08-26T10:00:00.000Z",
    });
  });

  it("coerces an ISO date so the binding it was chosen for actually holds", () => {
    const context = contextFor({ list: FLAT });
    let draft = applyStep(newDraft("d"), "endpoint", ["list"], context);
    draft = applyStep(draft, "component", ["timeseries"], context);
    draft = applyStep(draft, "role:time", ["createdAt"], context);
    draft = applyStep(draft, "role:value", ["amount"], context);
    draft = applyAnswer(draft, "title", ["Over time"]);

    const result = buildFromDraft(draft, context);
    expect(result.errors).toEqual([]);
    expect(result.widget?.pipeline).toContainEqual({
      op: "coerce",
      fields: { createdAt: "iso->datetime" },
    });
  });

  it("appends the accepted extras to the role that takes a list", () => {
    const context = contextFor({ list: FLAT });
    let draft = applyStep(newDraft("d"), "endpoint", ["list"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["name"], context);
    draft = applyAnswer(draft, "extras", ["amount", "status"]);
    draft = applyAnswer(draft, "title", ["Things"]);

    const result = buildFromDraft(draft, context);
    expect(result.widget?.roles.columns).toEqual(["name", "amount", "status"]);
  });

  it("asks for the dashboard filter a search box needs rather than assuming one", () => {
    const context = contextFor({ list: FLAT }, { searchable: [{ op: "list", param: "q" }] });
    let draft = applyStep(newDraft("d"), "endpoint", ["list"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["name"], context);
    draft = applyAnswer(draft, "options", ["endpointSearch"]);
    draft = applyAnswer(draft, "title", ["Things"]);

    const result = buildFromDraft(draft, context);
    expect(result.errors).toEqual([]);
    expect(result.widget?.source?.params).toEqual({ q: "{{param.search}}" });
    expect(result.requiresFilters).toEqual([{ key: "search", label: "Search", type: "text" }]);
  });

  it("shows every field of an opened record when the field question was skipped", () => {
    const context = contextFor(
      { list: FLAT, byId: FLAT.data[0]! },
      {
        drillDowns: [
          {
            resource: "thing",
            title: "Thing",
            listOp: "list",
            detailOp: "byId",
            idField: "id",
            detailParam: "thingId",
          },
        ],
      },
    );
    let draft = applyStep(newDraft("d"), "endpoint", ["list"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["name"], context);
    draft = applyStep(draft, "drilldown", ["byId"], context);
    draft = skipStep(draft, "drilldownFields");
    draft = applyAnswer(draft, "title", ["Things"]);

    const result = buildFromDraft(draft, context);
    expect(result.errors).toEqual([]);
    expect(result.widget?.drilldown?.params).toEqual({ thingId: "{{row.id}}" });
    expect(result.widget?.drilldown?.roles.fields).toContain("status");
    expect(result.authored?.cost.onOpen).toBe(1);
  });

  it("refuses a draft that is not finished rather than half-building it", () => {
    const context = contextFor({ list: FLAT });
    expect(buildFromDraft(newDraft("d"), context).errors[0]).toContain("no endpoint");
  });

  it("gives a colliding title its own id", () => {
    const context = contextFor({ list: FLAT });
    const { draft } = runToCompletion(context);
    const first = buildFromDraft(draft, context);
    const second = buildFromDraft(draft, context, { taken: new Set([first.widget!.id]) });
    expect(second.widget?.id).not.toBe(first.widget?.id);
  });
});

/* ── propose, then refine ──────────────────────────────────────────────── */

describe("the whole draft in one go", () => {
  const context = () => contextFor({ list: FLAT });

  it("accepts a complete proposal and produces a widget straight away", () => {
    const { draft, rejected } = revise(
      newDraft("d", "things by status", "assisted"),
      {
        endpoint: "list",
        component: "bar",
        roles: { category: ["status"], value: ["amount"] },
        title: "Amount by status",
      },
      context(),
    );

    expect(rejected).toEqual([]);
    // No question left that blocks a widget — which is what puts a preview on
    // screen instead of another card.
    expect(readiness(draft, context()).ready).toBe(true);
    expect(nextStep(draft, context())).toBeNull();

    const result = buildFromDraft(draft, context());
    expect(result.errors).toEqual([]);
    expect(result.widget?.roles).toEqual({ category: "status", value: "amount" });
  });

  it("rejects a field nobody offered, and says what was on offer", () => {
    const { draft, rejected } = revise(
      newDraft("d", "", "assisted"),
      { endpoint: "list", component: "bar", roles: { category: ["Vacancy"] } },
      context(),
    );

    const refusal = rejected.find((entry) => entry.value === "Vacancy");
    expect(refusal).toBeTruthy();
    expect(refusal?.available).toContain("status");
    // The endpoint and view landed; only the invented name did not.
    expect(draft.op).toBe("list");
    expect(draft.component).toBe("bar");
    expect(draft.roles.category).toBeUndefined();
  });

  it("does not settle a required step against a value nobody chose", () => {
    const { draft } = revise(
      newDraft("d", "", "assisted"),
      { endpoint: "list", component: "bar", roles: { category: ["nope"] } },
      context(),
    );
    // Still asked about, rather than silently built on a default.
    expect(readiness(draft, context()).missing.map((piece) => piece.stepId)).toContain(
      "role:category",
    );
  });

  it("applies outside-in, so roles are checked against the view just chosen", () => {
    // `time` only exists as a role once the view is a timeseries. Sent
    // together, the view has to land first for the role to be valid at all.
    const { draft, rejected } = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "timeseries",
        roles: { time: ["createdAt"], value: ["amount"] },
      },
      context(),
    );
    expect(rejected).toEqual([]);
    expect(draft.roles.time).toBe("createdAt");
  });

  it("takes the user's own words for the title without checking them", () => {
    const { draft, rejected } = revise(
      newDraft("d", "", "assisted"),
      { endpoint: "list", component: "table", roles: { columns: ["name"] }, title: "My things" },
      context(),
    );
    expect(rejected).toEqual([]);
    expect(draft.title).toBe("My things");
  });

  it("declines a step, which is not the same as leaving it unset", () => {
    // A control turned off has to *settle*, or the wizard keeps asking about
    // it and the card keeps showing it as an open decision.
    const context = contextFor({ list: FLAT });
    const built = revise(
      newDraft("d", "", "assisted"),
      { endpoint: "list", component: "table", roles: { columns: ["name"] } },
      context,
    ).draft;

    const before = allSteps(built, context).find((entry) => entry.step.id === "extras");
    expect(before?.settled).toBe(false);

    const after = revise(built, { skip: ["extras"] }, context).draft;
    const entry = allSteps(after, context).find((candidate) => candidate.step.id === "extras");
    expect(entry?.settled).toBe(true);
    expect(entry?.value).toEqual([]);
  });

  it("refuses a step that does not exist on this widget", () => {
    const { rejected } = revise(
      newDraft("d", "", "assisted"),
      { endpoint: "list", component: "table", roles: { nonsense: ["name"] } },
      context(),
    );
    expect(rejected.some((entry) => entry.stepId === "role:nonsense")).toBe(true);
  });
});

describe("assisted mode", () => {
  const context = () => contextFor({ list: FLAT });

  it("asks only what blocks a widget, never the optional polish", () => {
    let draft = newDraft("d", "things", "assisted");
    const asked: string[] = [];

    for (let guard = 0; guard < 20; guard++) {
      const step = nextStep(draft, context());
      if (!step) break;
      asked.push(step.id);
      const pick = step.options.find((option) => option.recommended) ?? step.options[0];
      draft = applyStep(draft, step.id, pick ? [pick.value] : [], context());
    }

    expect(asked).toContain("component");
    // All of these are controls on the card in this mode, not questions.
    for (const optional of ["options", "drilldown", "extras", "highlights", "title"]) {
      expect(asked, `${optional} was asked as a question`).not.toContain(optional);
    }
  });

  it("still walks every question in wizard mode", () => {
    const { steps } = runToCompletion(context());
    expect(steps.map((step) => step.id)).toContain("title");
  });
});

describe("the approval card's controls", () => {
  const context = () => contextFor({ list: FLAT });

  const complete = () =>
    revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "table",
        roles: { columns: ["name", "status"] },
        title: "Things",
      },
      context(),
    ).draft;

  it("offers one control per decision, with what it is set to", () => {
    const entries = allSteps(complete(), context());
    const byId = new Map(entries.map((entry) => [entry.step.id, entry]));

    expect(byId.get("endpoint")?.value).toEqual(["list"]);
    expect(byId.get("component")?.value).toEqual(["table"]);
    expect(byId.get("role:columns")?.value).toEqual(["name", "status"]);
    // Untouched optional decisions are still listed, so they can be turned on.
    expect(byId.has("extras")).toBe(true);
  });

  it("marks which decisions a widget cannot exist without", () => {
    const entries = allSteps(complete(), context());
    const required = entries.filter((entry) => entry.required).map((entry) => entry.step.id);
    expect(required).toContain("endpoint");
    expect(required).toContain("component");
    expect(required).toContain("role:columns");
    expect(required).not.toContain("extras");
    // A widget with no name still builds — the endpoint's own title stands in.
    expect(required).not.toContain("title");
  });

  it("stops listing decisions that depend on one still unmade", () => {
    // With no endpoint chosen there are no fields, so there is nothing
    // truthful to say about which view or which column.
    const entries = allSteps(newDraft("d", "", "assisted"), context());
    expect(entries.map((entry) => entry.step.id)).toEqual(["endpoint"]);
  });
});

/* ── a join nobody declared ────────────────────────────────────────────── */

describe("joining two endpoints on the assistant's say-so", () => {
  /*
   * The complaint this exists to answer: "Joins do exist as an option, but only
   * where a specific relationship between two endpoints has been defined for me
   * to use." A naming convention found the relationships; a naming convention
   * cannot cover every API, and the person asking often knows the two things
   * relate even when nothing in the schema says so.
   */
  const twoEndpoints = () =>
    contextFor({ list: FLAT, owners: OWNERS }, { joins: [] });

  const started = (context: ConciergeContext) =>
    revise(newDraft("d", "", "assisted"), { endpoint: "list" }, context).draft;

  it("joins two endpoints with no declared relationship at all", () => {
    const context = twoEndpoints();
    // Nothing was detected between these two.
    expect(context.joins).toEqual([]);

    const { draft, rejected } = revise(
      started(context),
      { joinWith: { endpoint: "owners", leftField: "id", rightField: "ownerId" } },
      context,
    );

    expect(rejected).toEqual([]);
    expect(draft.join).toMatchObject({
      op: "owners",
      leftField: "id",
      rightField: "ownerId",
      kind: "left",
      needsFanOut: false,
    });
  });

  it("puts the joined columns in the pool under the names the rows will carry", () => {
    const context = twoEndpoints();
    const { draft } = revise(
      started(context),
      { joinWith: { endpoint: "owners", leftField: "id", rightField: "ownerId" } },
      context,
    );
    const names = fieldPool(draft, context).map((field) => field.name);
    expect(names).toContain("owners_ownerName");
    expect(names).toContain("name");
  });

  it("builds a widget the spec accepts, and says what a join can do to a total", () => {
    const context = twoEndpoints();
    let draft = revise(
      started(context),
      { joinWith: { endpoint: "owners", leftField: "id", rightField: "ownerId" } },
      context,
    ).draft;
    draft = revise(
      draft,
      { component: "table", roles: { columns: ["name", "owners_ownerName"] }, title: "Both" },
      context,
    ).draft;

    const result = buildFromDraft(draft, context);
    expect(result.errors).toEqual([]);
    expect(result.widget?.combine).toMatchObject({
      on: { left: "id", right: "ownerId" },
      kind: "left",
    });
    // A guessed join can multiply or drop rows, and that has to be said before
    // anybody reads a number off it.
    expect(result.warnings.join(" ")).toContain("appears several times");
  });

  it("keeps unmatched rows rather than deleting them", () => {
    // An inner join on a wrong guess empties the widget and says nothing about
    // why. A left join leaves the evidence on screen.
    const context = twoEndpoints();
    const { draft } = revise(
      started(context),
      { joinWith: { endpoint: "owners", leftField: "id", rightField: "ownerId" } },
      context,
    );
    expect(draft.join?.kind).toBe("left");
  });

  it("refuses a field that is not on the widget's own rows", () => {
    const context = twoEndpoints();
    const { draft, rejected } = revise(
      started(context),
      { joinWith: { endpoint: "owners", leftField: "Nonexistent", rightField: "ownerId" } },
      context,
    );
    expect(rejected[0]?.reason).toContain("not a field on this widget");
    expect(rejected[0]?.available).toContain("name");
    expect(draft.join).toBeUndefined();
  });

  it("refuses a field that is not on the endpoint being joined", () => {
    const context = twoEndpoints();
    const { rejected } = revise(
      started(context),
      { joinWith: { endpoint: "owners", leftField: "id", rightField: "Nonexistent" } },
      context,
    );
    expect(rejected[0]?.reason).toContain('not a field on "owners"');
    expect(rejected[0]?.available).toContain("ownerName");
  });

  it("refuses an endpoint nothing has been read from", () => {
    const context: ConciergeContext = {
      ...twoEndpoints(),
      ops: [
        { id: "list", title: "list", connection: "api" },
        { id: "owners", title: "owners", connection: "api" },
        { id: "unread", title: "unread", connection: "api" },
      ],
    };
    const { rejected } = revise(
      started(context),
      { joinWith: { endpoint: "unread", leftField: "id", rightField: "whatever" } },
      context,
    );
    expect(rejected[0]?.reason).toContain("has not been read");
  });

  it("refuses to join an endpoint to itself", () => {
    const context = twoEndpoints();
    const { rejected } = revise(
      started(context),
      { joinWith: { endpoint: "list", leftField: "id", rightField: "id" } },
      context,
    );
    expect(rejected[0]?.reason).toContain("cannot be joined to itself");
  });

  it("never fans out on a guess", () => {
    // A detected join can be worth one request per row because something
    // verified the relationship. A guessed one is a hunch, and testing a hunch
    // at twenty-five requests is not a trade anybody agreed to.
    const context = twoEndpoints();
    const { draft } = revise(
      started(context),
      { joinWith: { endpoint: "owners", leftField: "id", rightField: "ownerId" } },
      context,
    );
    expect(draft.join?.needsFanOut).toBe(false);
  });
});

/* ── the universality guard ────────────────────────────────────────────── */

describe("universality", () => {
  const FIXTURES: ReadonlyArray<[string, unknown]> = [
    ["flat collection with ISO dates", FLAT],
    ["nested rows with unix seconds and a foreign key", NESTED],
    ["fields whose names mean nothing", OPAQUE],
  ];

  for (const [name, body] of FIXTURES) {
    it(`derives a sensible conversation for a ${name}`, () => {
      const context = contextFor({ list: body });
      const { steps, draft } = runToCompletion(context);

      // A view was offered and a widget came out the other end.
      expect(steps.map((step) => step.id)).toContain("component");
      const result = buildFromDraft(draft, context);
      expect(result.errors, `${name}: ${result.errors.join("; ")}`).toEqual([]);
      expect(result.widget).toBeTruthy();

      // Every question had something to answer it with.
      for (const step of steps) {
        expect(step.options.length > 0 || step.freeText === true, `${step.id} had no options`).toBe(
          true,
        );
      }
    });
  }

  /**
   * The rule that keeps this honest.
   *
   * Every question is generated from the endpoint's own shape and the shipped
   * component contracts, so no question text can name a domain. A word from
   * one API's vocabulary appearing in a question is the failure this whole
   * design exists to prevent, and it would not show up in any other test —
   * the widget would still build, it would just be built by something that
   * only works on the API it was written against.
   */
  it("puts no vendor or domain vocabulary in the questions", () => {
    const banned = [
      "buildium",
      "lease",
      "tenant",
      "property",
      "unit",
      "rent",
      "invoice",
      "github",
      "stripe",
      "repo",
      "issue",
      "customer",
      "order",
    ];

    for (const [, body] of FIXTURES) {
      const context = contextFor({ list: body });
      const { steps } = runToCompletion(context);
      for (const step of steps) {
        // Option labels come from the API's own field names and are meant to,
        // so only the text this file writes is checked.
        const authored = `${step.question} ${step.help ?? ""}`.toLowerCase();
        for (const word of banned) {
          expect(authored, `"${word}" leaked into "${step.id}"`).not.toContain(word);
        }
      }
    }
  });

  it("refuses an invented field on every one of them", () => {
    for (const [name, body] of FIXTURES) {
      const context = contextFor({ list: body });
      const { draft, rejected } = revise(
        newDraft("d", "", "assisted"),
        { endpoint: "list", component: "table", roles: { columns: ["totally_made_up"] } },
        context,
      );
      expect(rejected.length, `${name} absorbed a field that does not exist`).toBeGreaterThan(0);
      expect(draft.roles.columns).toBeUndefined();
    }
  });

  it("reads shape rather than names, so opaque fields still bind", () => {
    const context = contextFor({ list: OPAQUE });
    let draft = applyStep(newDraft("d"), "endpoint", ["list"], context);
    draft = applyStep(draft, "component", ["timeseries"], context);

    const step = nextStep(draft, context);
    expect(step?.id).toBe("role:time");
    // `f3` is a date only because its values parse as one. Nothing about the
    // name says so, and nothing in the rules looked at it.
    expect(step?.options.find((option) => option.recommended)?.value).toBe("f3");
  });
});

/* ── narrowing to values a person confirmed ────────────────────────────── */

describe("a confirmed narrowing", () => {
  const TASKS = {
    rows: [
      { Id: 1, Title: "Leak", Category: { Name: "Maintenance" } },
      { Id: 2, Title: "Query", Category: { Name: "General Inquiry" } },
      { Id: 3, Title: "Drain", Category: { Name: "Plumbing" } },
      { Id: 4, Title: "Boiler", Category: { Name: "Maintenance" } },
    ],
  };

  const built = (values: (string | number)[], field = "Category.Name") => {
    const context = contextFor({ tasks: TASKS });
    let draft = applyStep(newDraft("d"), "endpoint", ["tasks"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["Id", "Title"], context);
    draft = applyAnswer(draft, "title", ["Maintenance tasks"]);
    return buildFromDraft({ ...draft, narrow: { field, values } }, context);
  };

  it("writes the values into the pipeline as a filter", () => {
    const result = built(["Maintenance", "Plumbing"]);
    expect(result.errors).toEqual([]);

    const filters = (result.widget?.pipeline ?? []).filter((step) => step.op === "filter");
    expect(filters).toHaveLength(1);
    // A dotted name is a single field reference to the lexer, so it is written
    // plainly — quoting it would turn it into something else entirely.
    expect(filters[0]).toMatchObject({
      where: "Category.Name in ['Maintenance', 'Plumbing']",
    });
  });

  it("actually selects those records and no others", () => {
    const result = built(["Maintenance"]);
    const executed = executeWidget(result.widget!, TASKS, {
      now: Date.parse("2026-08-01T00:00:00Z"),
      params: { range: resolveRange({ preset: "12mo", now: Date.parse("2026-08-01T00:00:00Z") }), filters: {} },
    });

    expect(executed.errors).toEqual([]);
    expect(executed.ok).toBe(true);
    expect(executed.rows.map((row) => row["Id"])).toEqual([1, 4]);
  });

  it("keeps a number a number", () => {
    const NUMERIC = { rows: [{ Id: 1, CategoryId: 1688 }, { Id: 2, CategoryId: 1687 }] };
    const context = contextFor({ tasks: NUMERIC });
    let draft = applyStep(newDraft("d"), "endpoint", ["tasks"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["Id"], context);
    const result = buildFromDraft(
      { ...draft, narrow: { field: "CategoryId", values: [1688] } },
      context,
    );

    // `'1688'` would compare false against the number and quietly show an
    // empty widget that looks like a category with no records in it.
    const filters = (result.widget?.pipeline ?? []).filter((step) => step.op === "filter");
    expect(filters[0]).toMatchObject({ where: "CategoryId in [1688]" });
  });

  it("escapes a value containing a quote rather than breaking the expression", () => {
    const result = built(["Owner's request"]);
    expect(result.errors).toEqual([]);
    const filters = (result.widget?.pipeline ?? []).filter((step) => step.op === "filter");
    expect(filters[0]).toMatchObject({ where: String.raw`Category.Name in ['Owner\'s request']` });
  });

  it("changes nothing when no narrowing was confirmed", () => {
    const context = contextFor({ tasks: TASKS });
    let draft = applyStep(newDraft("d"), "endpoint", ["tasks"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["Id"], context);
    const result = buildFromDraft(draft, context);

    expect((result.widget?.pipeline ?? []).some((step) => step.op === "filter")).toBe(false);
  });
});

/* ── a record with its children beside it ──────────────────────────────── */

describe("related collections on a record", () => {
  const TASKS = { rows: [{ Id: 1, Title: "Leak", Status: "New" }] };
  const TASK = { Id: 1, Title: "Leak", Status: "New", Description: "Kitchen" };

  const withSections = (sections: Parameters<typeof buildFromDraft>[0]["drilldown"] extends
    | { sections: infer S }
    | undefined
    ? S
    : never) => {
    const context = contextFor({ tasks: TASKS, taskById: TASK, taskNotes: { rows: [] } });
    let draft = applyStep(newDraft("d"), "endpoint", ["tasks"], context);
    draft = applyStep(draft, "component", ["table"], context);
    draft = applyStep(draft, "role:columns", ["Id", "Title"], context);
    return buildFromDraft(
      {
        ...draft,
        drilldown: {
          op: "taskById",
          param: "taskId",
          idField: "Id",
          fields: ["Title"],
          groups: [],
          sections,
        },
      },
      context,
    );
  };

  it("matches a section's rows to the record when the endpoint cannot filter", () => {
    const result = withSections([
      {
        id: "notes-of-task",
        title: "Notes",
        op: "taskNotes",
        linkField: "TaskId",
        columns: ["Id"],
        rowsPath: "$.rows",
      },
    ]);

    expect(result.errors).toEqual([]);
    const related = (result.widget?.drilldown?.related ?? []) as Array<Record<string, unknown>>;
    expect(related).toHaveLength(1);
    expect(related[0]?.["title"]).toBe("Notes");

    /*
     * Matched on the rows, because no query parameter was declared. Sending an
     * invented one is worse than not filtering: an API free to ignore it
     * answers 200 with the whole collection, so the section looks healthy
     * while showing every note in the account.
     */
    const pipeline = JSON.stringify(related[0]?.["pipeline"]);
    expect(pipeline).toContain("string(TaskId)");
    expect(pipeline).toContain("{{row.Id}}");
    expect(related[0]?.["params"]).toEqual({});
  });

  it("narrows the request instead when the endpoint declares a parameter", () => {
    const result = withSections([
      {
        id: "notes-of-task",
        title: "Notes",
        op: "taskNotes",
        linkField: "TaskId",
        filterParam: "taskId",
        columns: ["Id"],
        rowsPath: "$.rows",
      },
    ]);

    const related = (result.widget?.drilldown?.related ?? []) as Array<Record<string, unknown>>;
    // One filtered request beats fetching everything and discarding most of it.
    expect(related[0]?.["params"]).toEqual({ taskId: "{{row.Id}}" });
    expect(JSON.stringify(related[0]?.["pipeline"])).not.toContain("string(TaskId)");
  });

  it("says in the summary what sits beside the record", () => {
    const result = withSections([
      {
        id: "notes-of-task",
        title: "Notes",
        op: "taskNotes",
        linkField: "TaskId",
        columns: ["Id"],
        rowsPath: "$.rows",
      },
    ]);
    expect(result.authored?.why.join(" ")).toContain("Notes");
  });

  it("builds a plain record when there are none, as before", () => {
    const result = withSections([]);
    expect(result.errors).toEqual([]);
    // `sections` is the draft's word for them; the widget spec calls them
    // `related`, and an empty list is the normal case.
    expect(result.widget?.drilldown?.related).toEqual([]);
  });
});

describe('when a setup began', () => {
  /*
   * A durable draft cannot say whether somebody is in the middle of it or
   * walked away from it yesterday, and those want opposite treatment. The card
   * reads this to tell them apart; before it existed every new setup was
   * presented as an abandoned one to resume or discard.
   */
  it('stamps a new draft with the time it started', () => {
    const draft = newDraft('d1', undefined, 'assisted', () => new Date('2026-08-25T10:00:00Z'));
    expect(draft.startedAt).toBe('2026-08-25T10:00:00.000Z');
  });

  it('keeps it when changing the API restarts the draft', () => {
    const started = newDraft('d1', undefined, 'assisted', () => new Date('2026-08-25T10:00:00Z'));
    // `applyAnswer` is deliberately context-free — the draft module has no idea
    // a capability report exists — so this is the three-argument form.
    const moved = applyAnswer({ ...started, connection: 'other' }, 'connection', ['conn']);
    // Everything downstream is discarded, deliberately. The sitting is not:
    // this is one answer inside it, and treating it as a new setup would
    // ambush somebody with the resume question mid-conversation.
    expect(moved.op).toBeUndefined();
    expect(moved.startedAt).toBe('2026-08-25T10:00:00.000Z');
  });
});

/**
 * Counting rows, from the patch a proposal produces to the widget that is
 * built — the whole chain the reported bug ran through.
 *
 * Asked to graph how many records there were per month, the machine used to
 * bind a chart to one endpoint and then ask which numeric field to plot,
 * because a role binds to a column and a count is not a column until a group
 * step creates one. Nothing in the draft could ask for that step.
 */
describe("measuring, rather than plotting a column", () => {
  const context = contextFor({ list: FLAT });

  const shape = {
    groupBy: [{ field: "createdAt", bucket: "1mo" as const }],
    measures: [{ as: "count", agg: "count" as const }],
    sort: [],
  };

  it("records the measurement and never asks which value to plot", () => {
    const { draft, rejected } = revise(
      newDraft("d1", "how many per month"),
      { endpoint: "list", component: "timeseries", shape },
      context,
    );

    expect(rejected).toEqual([]);
    expect(draft.shape?.measures).toEqual([{ as: "count", agg: "count" }]);

    // The question that used to be asked — and could only be answered wrongly.
    const asked = allSteps(draft, context).map((entry) => entry.step.id);
    expect(asked).not.toContain("role:value");
    expect(asked).not.toContain("role:time");
    expect(readiness(draft, context).ready).toBe(true);
  });

  it("builds a widget that counts, with the value role on the produced column", () => {
    const { draft } = revise(
      newDraft("d1", "how many per month"),
      { endpoint: "list", component: "timeseries", shape },
      context,
    );
    const built = buildFromDraft(draft, context);

    expect(built.errors).toEqual([]);
    expect(built.widget?.roles).toMatchObject({ time: "createdAt", value: "count" });
    expect(built.widget?.pipeline.find((step) => step.op === "group")).toMatchObject({
      agg: { count: "count()" },
    });
  });

  it("carries a filter, so a narrowing in the request is not lost", () => {
    const { draft, rejected } = revise(
      newDraft("d1", "how many active per month"),
      {
        endpoint: "list",
        component: "timeseries",
        shape: { ...shape, filter: 'status == "active"' },
      },
      context,
    );
    expect(rejected).toEqual([]);
    const built = buildFromDraft(draft, context);
    expect(built.widget?.pipeline.find((step) => step.op === "filter")).toMatchObject({
      where: 'status == "active"',
    });
  });

  it("refuses a measurement naming a field the rows do not have", () => {
    const { draft, rejected } = revise(
      newDraft("d1", "how many per month"),
      {
        endpoint: "list",
        component: "timeseries",
        shape: { groupBy: [{ field: "invented" }], measures: [], sort: [] },
      },
      context,
    );
    expect(rejected[0]?.stepId).toBe("shape");
    expect(rejected[0]?.reason).toContain("invented");
    // Refused whole, not half-applied: a measurement naming one real field and
    // one invented one is a different question, not a partly right answer.
    expect(draft.shape).toBeUndefined();
  });

  it("leaves an unmeasured widget exactly as it was", () => {
    const { draft } = revise(
      newDraft("d1", "list them"),
      { endpoint: "list", component: "table" },
      context,
    );
    expect(draft.shape).toBeUndefined();
    const built = buildFromDraft(draft, context);
    // Extract and nothing else — the shape is additive, and absent means the
    // behaviour that shipped before it existed.
    expect(built.widget?.pipeline.map((step) => step.op)).toEqual(["extract"]);
  });
});

/**
 * Two measurements over one axis, which is not a join and cannot be made into
 * one: neither set of rows is an attribute of the other, so there is nothing
 * to match them on.
 *
 * This replaced a form that could say exactly one thing — two endpoints,
 * counted, over a date. The runtime needed no change to generalise it: sources
 * already allows four and the union already stacks all of them.
 */
describe("several measurements beside each other", () => {
  const context = contextFor({ list: FLAT, others: NESTED });

  const counted = (field: string) => ({
    groupBy: [{ field, bucket: "1mo" as const }],
    measures: [{ as: "count", agg: "count" as const }],
    sort: [],
  });

  const twoSided = () =>
    revise(
      newDraft("d1", "how many of each per month"),
      {
        endpoint: "list",
        component: "timeseries",
        shape: counted("createdAt"),
        seriesWith: [{ endpoint: "others", label: "Others", shape: counted("opened") }],
      },
      context,
    );

  it("records both sides, each measured on its own fields", () => {
    const { draft, rejected } = twoSided();
    expect(rejected).toEqual([]);
    expect(draft.series).toHaveLength(1);
    expect(draft.series[0]?.label).toBe("Others");
    expect(draft.series[0]?.shape.groupBy[0]?.field).toBe("opened");
  });

  it("stacks them, and makes them agree on their column names", () => {
    const built = buildFromDraft(twoSided().draft, context);
    expect(built.errors).toEqual([]);

    const spec = built.widget!;
    expect(spec.sources).toHaveLength(2);
    expect(spec.combine).toEqual({ op: "union", as: "series" });
    expect(spec.roles).toMatchObject({ time: "bucket", value: "count", series: "series" });

    /*
     * The sides group different fields into the same two columns. Without that
     * the union stacks rows with nothing in common and the chart has no axis.
     */
    for (const source of spec.sources) {
      const group = source.pipeline.find((step) => step.op === "group");
      expect(group).toMatchObject({ by: [{ as: "bucket" }], agg: { count: "count()" } });
    }
    // The endpoint's own title, never an op id and never the widget's title.
    expect(spec.sources.map((source) => source.label)).toEqual(["list", "Others"]);
  });

  it("warns that an empty bucket is a gap rather than a zero", () => {
    const built = buildFromDraft(twoSided().draft, context);
    expect(built.warnings.join(" ")).toContain("rather than a zero");
  });

  it("drops a side naming a field that endpoint does not have, and keeps the rest", () => {
    const { draft, rejected } = revise(
      newDraft("d1", "compare them"),
      {
        endpoint: "list",
        component: "timeseries",
        shape: counted("createdAt"),
        seriesWith: [
          { endpoint: "others", label: "Others", shape: counted("opened") },
          { endpoint: "others", label: "Invented", shape: counted("no_such_field") },
        ],
      },
      context,
    );
    expect(draft.series).toHaveLength(1);
    expect(rejected[0]?.stepId).toBe("seriesWith");
    expect(rejected[0]?.reason).toContain("no_such_field");
  });

  /*
   * A draft written before `series` existed still parses, and `settle`
   * converts it in one place rather than every reader knowing both shapes.
   */
  it("migrates a comparison written in the older form", () => {
    const legacy = {
      ...newDraft("d1"),
      connection: "api",
      op: "list",
      component: "timeseries",
      compare: {
        op: "others",
        rowsPath: "$",
        leftTimeField: "createdAt",
        rightTimeField: "opened_at",
        leftLabel: "Things",
        rightLabel: "Others",
        measure: "count" as const,
      },
    };
    const settled = settle(legacy, context);
    expect(settled.compare).toBeUndefined();
    expect(settled.series).toHaveLength(1);
    expect(settled.series[0]?.label).toBe("Others");
    expect(buildFromDraft(settled, context).widget?.sources).toHaveLength(2);
  });
});

/**
 * Measuring a collection that only exists under a parent.
 *
 * The half of the reported request that could not be built at all: the only
 * endpoint listing applications needs an applicant's id, so it was excluded
 * from every candidate list as "not a starting point" and never considered.
 * It is reachable — one request per applicant — and the whole question is
 * whether somebody agrees to spend that.
 */
describe("a nested collection, priced before it is counted", () => {
  const PARENTS = { data: [{ id: 7, name: "Ada" }, { id: 8, name: "Grace" }] };
  const CHILDREN = { data: [{ ref: 1, submittedAt: "2026-02-02T00:00:00Z" }] };
  const context = contextFor({ list: FLAT, parents: PARENTS, children: CHILDREN });

  const counted = (field: string) => ({
    groupBy: [{ field, bucket: "1mo" as const }],
    measures: [{ as: "count", agg: "count" as const }],
    sort: [],
  });

  const offered = () => {
    const { draft } = revise(
      newDraft("d1", "listings against applications per month"),
      { endpoint: "list", component: "timeseries", shape: counted("createdAt") },
      context,
    );
    return {
      ...draft,
      offer: {
        op: "children",
        rowsPath: "$",
        label: "Applications",
        shape: counted("submittedAt"),
        fanOut: { from: "parents", field: "id", as: "parentId", maxRows: 25 },
      },
    };
  };

  it("asks before spending anything, with the arithmetic in the question", () => {
    const step = allSteps(offered(), context).find((entry) => entry.step.id === "offer");
    expect(step).toBeDefined();
    // The records' own noun, not the endpoint's title verbatim.
    expect(step?.step.question).toBe("Also count the applications?");
    expect(step?.step.help).toContain("one request per record");
    expect(step?.step.help).toContain("25");
    // Never required: declining has to produce a widget, not a dead end.
    expect(step?.required).toBe(false);
  });

  it("counts nothing until it is accepted", () => {
    const declined = applyStep(offered(), "offer", ["skip"], context);
    expect(declined.series).toEqual([]);
    expect(declined.offer).toBeUndefined();

    const built = buildFromDraft(declined, context);
    // Still a real widget, built from the rest.
    expect(built.errors).toEqual([]);
    expect(built.widget?.sources ?? []).toHaveLength(0);
  });

  it("fetches the parent as a hidden source once accepted, and does not draw it", () => {
    const accepted = applyStep(offered(), "offer", ["include"], context);
    const built = buildFromDraft(accepted, context);
    expect(built.errors).toEqual([]);

    const spec = built.widget!;
    expect(spec.sources).toHaveLength(3);

    const hidden = spec.sources.filter((source) => source.hidden);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.op).toBe("parents");

    // The fan-out points at the driver by its source name, not its endpoint id.
    const child = spec.sources.find((source) => source.op === "children");
    expect(child?.fanOut?.from).toBe(hidden[0]?.as);

    // Two series drawn, not three: the parent is how the children are reached,
    // not one of the things being measured.
    expect(spec.sources.filter((source) => !source.hidden)).toHaveLength(2);
  });

  it("says the number is a sample rather than a total", () => {
    const accepted = applyStep(offered(), "offer", ["include"], context);
    const built = buildFromDraft(accepted, context);
    expect(built.warnings.join(" ")).toContain("sample rather than a total");
  });

  it("refuses a driver that cannot supply the id", () => {
    const { rejected } = revise(
      newDraft("d1", "compare"),
      {
        endpoint: "list",
        component: "timeseries",
        shape: counted("createdAt"),
        seriesWith: [
          {
            endpoint: "children",
            label: "Applications",
            shape: counted("submittedAt"),
            fanOut: { from: "parents", field: "no_such_field" },
          },
        ],
      },
      context,
    );
    expect(rejected[0]?.reason).toContain("cannot supply the id");
  });
});

/**
 * The measurement as controls, so it can be changed without starting again.
 *
 * Every decision the shape holds is one the user should be able to see and
 * reach — that is what "a saved mutation" means. A widget that counts because
 * a model decided to, with nothing on screen saying so and no way to change
 * it, is not much better than one that counted the wrong thing.
 */
describe("adjusting what a widget measures", () => {
  const context = contextFor({ list: FLAT });

  const measured = () =>
    revise(
      newDraft("d1", "how many per month"),
      {
        endpoint: "list",
        component: "timeseries",
        shape: {
          filter: 'status == "active"',
          groupBy: [{ field: "createdAt", bucket: "1mo" }],
          measures: [{ as: "count", agg: "count" }],
          sort: [],
        },
      },
      context,
    ).draft;

  const control = (draft: ReturnType<typeof measured>, id: string) =>
    allSteps(draft, context).find((entry) => entry.step.id === id);

  it("shows the measurement, the grouping and the filter, each set", () => {
    const draft = measured();
    expect(control(draft, "measure")?.value).toEqual(["count:"]);
    expect(control(draft, "groupBy")?.value).toEqual(["createdAt"]);
    expect(control(draft, "filter")?.value).toEqual(['status == "active"']);
  });

  it("offers counting the records first, then the numbers there are to total", () => {
    const options = control(measured(), "measure")?.step.options ?? [];
    expect(options[0]?.value).toBe("count:");
    expect(options.map((option) => option.value)).toContain("sum:amount");
  });

  it("changes what is measured, and moves the value role with it", () => {
    const summed = applyStep(measured(), "measure", ["sum:amount"], context);
    expect(summed.shape?.measures).toEqual([{ as: "amount", agg: "sum", field: "amount" }]);

    const built = buildFromDraft(summed, context);
    expect(built.widget?.roles).toMatchObject({ time: "createdAt", value: "amount" });
    expect(built.widget?.pipeline.find((step) => step.op === "group")).toMatchObject({
      agg: { amount: "sum(amount)" },
    });
  });

  it("goes back to counting the records", () => {
    const summed = applyStep(measured(), "measure", ["sum:amount"], context);
    const counted = applyStep(summed, "measure", ["count:"], context);
    expect(counted.shape?.measures).toEqual([{ as: "count", agg: "count" }]);
    expect(buildFromDraft(counted, context).widget?.roles.value).toBe("count");
  });

  it("buckets a date and does not bucket anything else", () => {
    const byDate = applyStep(measured(), "groupBy", ["createdAt"], context);
    expect(byDate.shape?.groupBy).toEqual([{ field: "createdAt", bucket: "{{range.grain}}" }]);

    const byStatus = applyStep(measured(), "groupBy", ["status"], context);
    expect(byStatus.shape?.groupBy).toEqual([{ field: "status" }]);
  });

  /*
   * Declining a filter means taking it off. Marking it answered and leaving
   * the rows narrowed would be a control that reads as removed and a widget
   * that still filters — silent, and precisely wrong.
   */
  it("removes the filter when it is declined", () => {
    const cleared = skipStep(measured(), "filter");
    expect(cleared.shape?.filter).toBeUndefined();
    expect(buildFromDraft(cleared, context).widget?.pipeline.some((s) => s.op === "filter")).toBe(
      false,
    );
  });

  it("has no measurement controls on a widget that measures nothing", () => {
    const plain = revise(
      newDraft("d1", "list them"),
      { endpoint: "list", component: "table" },
      context,
    ).draft;
    expect(control(plain, "measure")).toBeUndefined();
    expect(control(plain, "groupBy")).toBeUndefined();
  });
});

/**
 * Two readings of one request, put to the person who made it.
 *
 * The pick is a single required id, so a model looking at two defensible
 * readings had to commit and could not say the other existed. That is right
 * when both produce the same answer and wrong when they do not — counting the
 * things somebody submitted is not counting the people who submitted them, and
 * "they can change it in the settings" only helps somebody who noticed.
 */
describe("asking which of two readings was meant", () => {
  const context = contextFor({ list: FLAT, others: NESTED });

  const counted = (field: string) => ({
    groupBy: [{ field, bucket: "1mo" as const }],
    measures: [{ as: "count", agg: "count" as const }],
    sort: [],
  });

  const withChoice = (role: "primary" | "secondary") =>
    revise(
      newDraft("d1", "how many per month"),
      {
        endpoint: "list",
        component: "timeseries",
        shape: counted("createdAt"),
        choiceBetween: {
          role,
          options: [
            { op: "list", label: "The things", whatItIs: "What this is built from now." },
            {
              op: "others",
              label: "The others",
              whatItIs: "The records those things hang off.",
              series: { op: "others", rowsPath: "$", label: "The others", shape: counted("opened") },
            },
          ],
        },
      },
      context,
    ).draft;

  it("asks in the model's own words, with what is already applied recommended", () => {
    const step = allSteps(withChoice("primary"), context).find(
      (entry) => entry.step.id === "choice",
    );
    expect(step?.step.question).toBe("Which of these did you mean?");
    expect(step?.step.options.map((option) => option.description)).toEqual([
      "What this is built from now.",
      "The records those things hang off.",
    ]);
    expect(step?.step.options.find((option) => option.recommended)?.value).toBe("list");
  });

  /*
   * The one question worth stopping for. A widget counting the wrong thing
   * renders perfectly and reads as an answer, so this blocks where the
   * measurement controls do not.
   */
  it("blocks the build until it is answered", () => {
    const draft = withChoice("primary");
    expect(readiness(draft, context).missing.map((piece) => piece.stepId)).toContain("choice");
    expect(nextStep(draft, context)?.id).toBe("choice");
  });

  it("switches the endpoint, and drops what was bound to the old one", () => {
    const moved = applyStep(withChoice("primary"), "choice", ["others"], context);
    expect(moved.op).toBe("others");
    expect(moved.choice).toBeUndefined();
    // A different set of records means different fields.
    expect(moved.roles).toEqual({});
    // And the question does not come back.
    expect(allSteps(moved, context).some((entry) => entry.step.id === "choice")).toBe(false);
  });

  it("swaps the compared side when the choice was about the second endpoint", () => {
    const moved = applyStep(withChoice("secondary"), "choice", ["others"], context);
    expect(moved.op).toBe("list");
    expect(moved.series.map((side) => side.op)).toEqual(["others"]);
    expect(moved.choice).toBeUndefined();
  });

  /*
   * A side that has to be read once per record is a price, not a detail — so
   * choosing it hands over to the consent step rather than applying it.
   */
  it("turns a costly side into an offer rather than applying it", () => {
    const draft = revise(
      newDraft("d1", "how many per month"),
      {
        endpoint: "list",
        component: "timeseries",
        shape: counted("createdAt"),
        choiceBetween: {
          role: "secondary",
          options: [
            { op: "list", label: "The things", whatItIs: "Now." },
            {
              op: "others",
              label: "The others",
              whatItIs: "Listed per record.",
              series: {
                op: "others",
                rowsPath: "$",
                label: "The others",
                shape: counted("opened"),
                fanOut: { from: "list", field: "id", as: "listId", maxRows: 25 },
              },
            },
          ],
        },
      },
      context,
    ).draft;

    const moved = applyStep(draft, "choice", ["others"], context);
    expect(moved.series).toEqual([]);
    expect(moved.offer?.op).toBe("others");
    expect(allSteps(moved, context).some((entry) => entry.step.id === "offer")).toBe(true);
  });

  /*
   * The guardrail. A question asked on every build is the endpoint list this
   * whole flow exists to replace, so a clear request must reach a widget
   * without one.
   */
  it("asks nothing at all when the request was clear", () => {
    const plain = revise(
      newDraft("d1", "how many per month"),
      { endpoint: "list", component: "timeseries", shape: counted("createdAt") },
      context,
    ).draft;
    expect(allSteps(plain, context).some((entry) => entry.step.id === "choice")).toBe(false);
    expect(readiness(plain, context).ready).toBe(true);
  });
});

/**
 * A field one hop down, offered and bound.
 *
 * Asked for listings, the machine offered `Contact`, `Property` and `Unit` —
 * objects that render "[object Object]" — and hid `Unit.UnitNumber` and
 * `Property.Name`, which are the names a person identifies a record by. On a
 * real endpoint that was 24 of 34 fields invisible.
 *
 * The exclusion was honest at the time: the builder could not flatten one. So
 * the fix is on the builder, and the pool inverts — what is hidden is what
 * cannot be drawn.
 */
/*
 * The step machine settles some answers rather than asking them, and a patch
 * naming one of those was being told it had failed.
 */
describe("a value the draft already holds", () => {
  const context = contextFor({ list: FLAT });

  it("is applied silently, not reported as a refusal", () => {
    /*
     * `settle()` fills in the only connection there is, which removes the
     * question — so every proposal, which always names the connection it
     * chose, was handed back "there is no connection to set on this widget"
     * for a connection that was already set correctly. Nothing had failed and
     * the report said it had, on every single widget build.
     */
    const { draft, rejected } = revise(
      newDraft("d1", "show me the list"),
      { connection: "api", endpoint: "list", component: "table", roles: { columns: ["name"] } },
      context,
    );

    expect(rejected).toEqual([]);
    expect(draft.connection).toBe("api");
    expect(draft.op).toBe("list");
  });

  it("still refuses a value that is not the one the draft holds", () => {
    const { rejected } = revise(
      newDraft("d1", "show me the list"),
      { connection: "some-other-api", endpoint: "list" },
      context,
    );

    expect(rejected.map((entry) => entry.stepId)).toContain("connection");
  });
});

describe("nested fields, offered and bound", () => {
  const LISTING = {
    data: [
      {
        ListingDate: "2026-01-04T00:00:00Z",
        Rent: 1200,
        Contact: { Id: 1, Name: "Ada", Email: "ada@example.com" },
        Unit: { Id: 7, UnitNumber: "4B", Address: { AddressLine1: "12 Ash Lane", City: "Fresno" } },
      },
      {
        ListingDate: "2026-02-04T00:00:00Z",
        Rent: 900,
        Contact: { Id: 2, Name: "Grace", Email: "grace@example.com" },
        Unit: { Id: 8, UnitNumber: "1A", Address: { AddressLine1: "9 Elm Road", City: "Fresno" } },
      },
    ],
  };
  const context = contextFor({ listings: LISTING });

  const draft = () =>
    settle({ ...newDraft("d1"), connection: "api", op: "listings" }, context);

  it("offers what can be drawn and hides the containers around it", () => {
    const names = fieldPool(draft(), context).map((field) => field.name);
    expect(names).toContain("Unit.UnitNumber");
    expect(names).toContain("Contact.Name");
    // Two levels down, which is where an address lives.
    expect(names).toContain("Unit.Address.City");
    // The containers themselves render "[object Object]", so they are not offered.
    expect(names).not.toContain("Unit");
    expect(names).not.toContain("Contact");
  });

  /*
   * The half of "listings by address" that the derive fix did not reach.
   *
   * A card's subtitle and meta are optional roles, and optional roles had no
   * step — so `revise` could not apply one, and a model proposing the street
   * address as the subtitle had it thrown away one layer later. What arrived
   * was a card with a title and nothing else.
   */
  it("binds the optional roles a proposal fills, rather than dropping them", () => {
    const { draft: bound, rejected } = revise(
      newDraft("d1", "show me the listings"),
      {
        endpoint: "listings",
        component: "cards",
        roles: {
          title: ["Unit.UnitNumber"],
          subtitle: ["Unit.Address.AddressLine1"],
          meta: ["Rent"],
        },
      },
      context,
    );

    expect(rejected).toEqual([]);
    expect(bound.roles.subtitle).toBe("Unit.Address.AddressLine1");
    expect(bound.roles.meta).toBe("Rent");

    const built = buildFromDraft(bound, context);
    expect(built.errors).toEqual([]);
    expect(built.widget?.roles.subtitle).toBe("Unit_Address_AddressLine1");
  });

  /*
   * The control exists because something filled the role — the same shape the
   * `series:N` steps have. Without it a role the assistant set would be
   * invisible on the card and could not be taken off without starting over.
   */
  it("shows a filled optional role as a control, and an empty one not at all", () => {
    const { draft: bound } = revise(
      newDraft("d1", "show me the listings"),
      {
        endpoint: "listings",
        component: "cards",
        roles: { title: ["Unit.UnitNumber"], subtitle: ["Unit.Address.AddressLine1"] },
      },
      context,
    );

    const entry = allSteps(bound, context).find((step) => step.step.id === "role:subtitle");
    expect(entry?.settled).toBe(true);
    expect(entry?.required).toBe(false);
    expect(entry?.value).toEqual(["Unit.Address.AddressLine1"]);
    // Changeable, not just removable: the options are the same pool the role
    // would have been offered had it ever been asked about.
    expect(entry?.step.options.map((option) => option.value)).toContain("Contact.Name");
    expect(entry?.step.skippable).toBe(true);

    // Nothing filled `status`, so nothing asks about it — which is what keeps
    // the wizard from interrogating you about every optional role.
    expect(allSteps(bound, context).some((step) => step.step.id === "role:status")).toBe(false);
  });

  it("takes the field off the card when the optional control is declined", () => {
    const { draft: bound } = revise(
      newDraft("d1", "show me the listings"),
      {
        endpoint: "listings",
        component: "cards",
        roles: { title: ["Unit.UnitNumber"], subtitle: ["Unit.Address.AddressLine1"] },
      },
      context,
    );

    const without = skipStep(bound, "role:subtitle");
    expect(without.roles.subtitle).toBeUndefined();
    expect(buildFromDraft(without, context).widget?.roles.subtitle).toBeUndefined();
    // And the control goes with it, rather than lingering over a card that no
    // longer shows the field.
    expect(allSteps(without, context).some((step) => step.step.id === "role:subtitle")).toBe(false);
  });

  it("still refuses a field the endpoint does not have for an optional role", () => {
    const { draft: bound, rejected } = revise(
      newDraft("d1", "show me the listings"),
      {
        endpoint: "listings",
        component: "cards",
        roles: { title: ["Unit.UnitNumber"], subtitle: ["Invented.Field"] },
      },
      context,
    );

    expect(bound.roles.subtitle).toBeUndefined();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ stepId: "role:subtitle", value: "Invented.Field" });
    // Named back with what was available, the same treatment a required role
    // has always had.
    expect(rejected[0]?.available).toContain("Rent");
  });

  it("derives a nested field into a real column when it is bound", () => {
    const { draft: bound, rejected } = revise(
      newDraft("d1", "listings by unit"),
      {
        endpoint: "listings",
        component: "table",
        roles: { columns: ["Unit.UnitNumber", "Unit.Address.City", "Rent"] },
      },
      context,
    );
    expect(rejected).toEqual([]);

    const built = buildFromDraft(bound, context);
    expect(built.errors).toEqual([]);

    const derive = built.widget?.pipeline.find((step) => step.op === "derive");
    expect(derive).toMatchObject({
      fields: { Unit_UnitNumber: "Unit.UnitNumber", Unit_Address_City: "Unit.Address.City" },
    });
    // The role names the column the derive produces, not the path.
    expect(built.widget?.roles.columns).toEqual(["Unit_UnitNumber", "Unit_Address_City", "Rent"]);
  });

  it("derives before anything that names a column", () => {
    const { draft: bound } = revise(
      newDraft("d1", "listings by unit"),
      {
        endpoint: "listings",
        component: "bar",
        roles: { category: ["Unit.UnitNumber"] },
        shape: { groupBy: [{ field: "Unit.UnitNumber" }], measures: [{ as: "count", agg: "count" }], sort: [] },
      },
      context,
    );
    const ops = buildFromDraft(bound, context).widget?.pipeline.map((step) => step.op) ?? [];
    // A group referring to the flattened name cannot run before it exists.
    expect(ops.indexOf("derive")).toBeLessThan(ops.indexOf("group"));
  });

  it("groups a measurement by a nested field, on the column it produces", () => {
    const { draft: bound } = revise(
      newDraft("d1", "listings by city"),
      {
        endpoint: "listings",
        component: "bar",
        shape: {
          groupBy: [{ field: "Unit.Address.City" }],
          measures: [{ as: "count", agg: "count" }],
          sort: [],
        },
      },
      context,
    );
    const built = buildFromDraft(bound, context);
    expect(built.widget?.pipeline.find((step) => step.op === "group")).toMatchObject({
      by: [{ field: "Unit_Address_City" }],
    });
    expect(built.widget?.roles).toMatchObject({ category: "Unit_Address_City", value: "count" });
  });

  it("leaves a widget with no nested field exactly as it was", () => {
    const { draft: bound } = revise(
      newDraft("d1", "listings"),
      { endpoint: "listings", component: "table", roles: { columns: ["Rent"] } },
      context,
    );
    const ops = buildFromDraft(bound, context).widget?.pipeline.map((step) => step.op) ?? [];
    expect(ops).toEqual(["extract"]);
  });
});

/**
 * A join and its bindings arriving together, which is how they really arrive.
 *
 * Every join test above applies the join in one `revise` and the roles in the
 * next, and they all passed while the feature was broken — because a proposal
 * does not arrive in two calls. `proposeSetup` returns ONE patch carrying the
 * endpoint, the component, the roles and the join, and in that shape the order
 * inside `revise` decided the outcome:
 *
 *   1. roles were validated against a pool the join had not been added to yet,
 *      so any joined column was refused for naming a field that did not exist;
 *   2. `applyOpenJoin` then cleared `roles` outright — correctly, since the
 *      pool had changed — discarding whatever had survived step 1.
 *
 * The widget fetched the second endpoint, paid for it, and rendered the first
 * one alone. Asked for properties alongside their listings, that is a table of
 * properties and a request spent on nothing.
 */
describe("a join and its columns in one patch", () => {
  const context = () => contextFor({ list: FLAT, owners: OWNERS }, { joins: [] });

  /** Exactly the shape `proposeSetup` produces: everything at once. */
  const proposed = (ctx: ConciergeContext) =>
    revise(
      newDraft("d", "properties and their owners", "assisted"),
      {
        endpoint: "list",
        component: "table",
        roles: { columns: ["name", "status"] },
        joinWith: { endpoint: "owners", leftField: "id", rightField: "ownerId" },
        title: "Both",
      },
      ctx,
    );

  it("keeps the join", () => {
    const { draft } = proposed(context());
    expect(draft.join).toMatchObject({ op: "owners", leftField: "id", rightField: "ownerId" });
  });

  it("rejects nothing — the columns were always legitimate", () => {
    const { rejected } = proposed(context());
    expect(rejected).toEqual([]);
  });

  it("does not throw the proposed columns away", () => {
    const { draft } = proposed(context());
    expect(draft.roles["columns"]).toContain("name");
    expect(draft.roles["columns"]).toContain("status");
  });

  /*
   * The other half. The binding call is only ever shown the primary
   * endpoint's schema, so it cannot name a joined column even in principle —
   * which means "the roles survived" is not enough on its own. Something has
   * to put the second endpoint on screen, or the join is still invisible.
   */
  it("shows the joined endpoint's own columns", () => {
    const { draft } = proposed(context());
    const columns = draft.roles["columns"] ?? [];
    expect(columns).toContain("owners_ownerName");
  });

  it("does not add the key it just matched on, which is not what anyone meant", () => {
    const { draft } = proposed(context());
    expect(draft.roles["columns"]).not.toContain("owners_ownerId");
  });

  it("builds a widget carrying both endpoints", () => {
    const ctx = context();
    const result = buildFromDraft(proposed(ctx).draft, ctx);
    expect(result.errors).toEqual([]);
    expect(result.widget?.sources.map((source) => source.op)).toEqual(["list", "owners"]);
    expect(result.widget?.roles["columns"]).toContain("owners_ownerName");
  });

  /*
   * A comparison clears the join, so the columns it produced must not outlive
   * it — a widget showing `owners_ownerName` for a join that is gone renders a
   * column of blanks and says nothing about why.
   */
  it("adds nothing when a series has cleared the join", () => {
    const ctx = contextFor({ list: FLAT, owners: OWNERS }, { joins: [] });
    const { draft } = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "table",
        joinWith: { endpoint: "owners", leftField: "id", rightField: "ownerId" },
        seriesWith: [
          {
            endpoint: "owners",
            label: "Owners",
            shape: {
              groupBy: [{ field: "region" }],
              measures: [{ as: "count", agg: "count" }],
              sort: [],
            },
          },
        ],
      },
      ctx,
    );
    expect(draft.join).toBeUndefined();
    const bound = draft.roles["columns"] ?? [];
    const columns = Array.isArray(bound) ? bound : [bound];
    expect(columns.some((name) => name.startsWith("owners_"))).toBe(false);
  });
});

/**
 * A setup that builds more than one widget.
 *
 * "Show my properties and also my listings" is two collections that neither
 * join nor compare. Forcing them into one widget is what produced the original
 * failure; the answer is that they were never one widget. So a draft describes
 * a list of them, and the step machine — eleven hundred lines that correctly
 * answer "what does this ONE widget still need" — is run once per part against
 * a view rather than rewritten to count.
 */
describe("a setup of several widgets", () => {
  const context = () => contextFor({ list: FLAT, owners: OWNERS }, { joins: [] });

  const twoParts = (ctx: ConciergeContext) =>
    revise(
      newDraft("d", "my things and also my owners", "assisted"),
      {
        endpoint: "list",
        component: "table",
        roles: { columns: ["name"] },
        title: "Things",
        parts: [
          {
            endpoint: "owners",
            component: "table",
            roles: { columns: ["ownerName"] },
            title: "Owners",
          },
        ],
        group: { title: "Things and Owners", display: "tabs" },
      },
      ctx,
    );

  it("reads as one part when nothing said otherwise", () => {
    const ctx = context();
    const one = revise(newDraft("d", "", "assisted"), { endpoint: "list" }, ctx).draft;
    expect(partCount(one)).toBe(1);
    // Nothing is materialised, so a draft written before any of this parses
    // and behaves exactly as it did.
    expect(one.parts).toEqual([]);
  });

  it("takes a second part from the patch", () => {
    const { draft, rejected } = twoParts(context());
    expect(rejected).toEqual([]);
    expect(partCount(draft)).toBe(2);
    expect(partsOf(draft)[1]).toMatchObject({ op: "owners", component: "table", title: "Owners" });
  });

  it("keeps the primary readable where it always was", () => {
    const { draft } = twoParts(context());
    // Everything written before parts existed reads `draft.op`; it still sees
    // the first widget rather than undefined or the last one written.
    expect(draft.op).toBe("list");
    expect(draft.title).toBe("Things");
    expect(partsOf(draft)[0]?.op).toBe("list");
  });

  it("holds the frame without building it", () => {
    const { draft } = twoParts(context());
    expect(draft.group).toMatchObject({ title: "Things and Owners", display: "tabs" });
  });

  it("checks each part's fields against its own endpoint", () => {
    const ctx = context();
    const { rejected } = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "table",
        parts: [{ endpoint: "owners", component: "table", roles: { columns: ["name"] } }],
      },
      ctx,
    );
    // `name` is a field on `list`, not on `owners`. A patch that names it for
    // the second widget is refused exactly as it would be for the first.
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.stepId).toBe("p1:role:columns");
  });

  it("scopes a second part's steps and leaves the first's bare", () => {
    const ctx = context();
    const ids = allStepsAcross(twoParts(ctx).draft, ctx).map((entry) => entry.step.id);
    expect(ids).toContain("component");
    expect(ids).toContain("p1:component");
    expect(ids.filter((id) => id.startsWith("p1:")).length).toBeGreaterThan(0);
  });

  it("reads and writes an answer through a scoped id", () => {
    const ctx = context();
    let draft = twoParts(ctx).draft;
    draft = applyStepAcross(draft, "p1:title", ["Renamed"], ctx);
    expect(valueOfAcross(draft, "p1:title")).toEqual(["Renamed"]);
    // The first widget is untouched by an answer about the second.
    expect(valueOfAcross(draft, "title")).toEqual(["Things"]);
  });

  it("is ready only when every part is", () => {
    const ctx = context();
    const half = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "table",
        roles: { columns: ["name"] },
        parts: [{ endpoint: "owners" }],
      },
      ctx,
    ).draft;
    const state = readinessAcross(half, ctx);
    expect(state.ready).toBe(false);
    // And it says which widget is short, rather than just that something is.
    expect(state.missing.some((piece) => piece.stepId.startsWith("p1:"))).toBe(true);
  });

  it("builds every widget, with ids that do not collide", () => {
    const ctx = context();
    const result = buildAll(twoParts(ctx).draft, ctx);
    expect(result.errors).toEqual([]);
    expect(result.widgets).toHaveLength(2);
    expect(new Set(result.widgets.map((widget) => widget.id)).size).toBe(2);
    expect(result.widgets.map((widget) => widget.title)).toEqual(["Things", "Owners"]);
    expect(result.group).toMatchObject({ title: "Things and Owners", display: "tabs" });
  });

  /*
   * All or nothing. A setup that wrote the properties and silently dropped the
   * listings is the exact half-success this whole tier exists to stop.
   */
  it("returns nothing at all when one part cannot be built", () => {
    const ctx = context();
    const good = twoParts(ctx).draft;
    // A part with no view is the simplest thing `buildFromDraft` refuses, and
    // refusing it is the behaviour under test rather than how it got that way.
    const broken = withPart(good, 1, {
      ...partView(good, 1),
      // An endpoint nothing has been read from: no fields, so no role can be
      // filled and no default can rescue it.
      op: "ghost",
      component: undefined,
      roles: {},
    });
    const result = buildAll(broken, ctx);
    expect(result.widgets).toEqual([]);
    // And the failure names which widget it is about.
    expect(result.errors.join(" ")).toContain("widget 2");
  });

  it("does not report a frame for a single widget", () => {
    const ctx = context();
    const one = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "table",
        roles: { columns: ["name"] },
        group: { title: "Alone" },
      },
      ctx,
    ).draft;
    expect(buildAll(one, ctx).group).toBeUndefined();
  });

  it("builds a one-part setup exactly as it always did", () => {
    const ctx = context();
    const draft = revise(
      newDraft("d", "", "assisted"),
      { endpoint: "list", component: "table", roles: { columns: ["name"] }, title: "Things" },
      ctx,
    ).draft;
    const one = buildFromDraft(draft, ctx);
    const all = buildAll(draft, ctx);
    expect(all.widgets).toHaveLength(1);
    expect(all.widgets[0]).toEqual(one.widget);
  });
});

/**
 * Two kinds of record in one list, badged by which they came from.
 *
 * The third arrangement, and the one that needed no schema change at all:
 * `runPlan`'s union already stacks rows without requiring the sources to share
 * columns, each source already has its own pipeline, and `select`, `rename`
 * and `highlight` have all shipped for months. What was missing was something
 * to write them — so each part renames its own bound fields onto the
 * component's role names, and two endpoints that share no vocabulary arrive as
 * rows that do.
 */
describe("one list, two kinds of record", () => {
  const context = () => contextFor({ list: FLAT, owners: OWNERS }, { joins: [] });

  const interleaved = (ctx: ConciergeContext, component = "list") =>
    revise(
      newDraft("d", "everything in one list", "assisted"),
      {
        endpoint: "list",
        component,
        roles: { title: ["name"], subtitle: ["status"] },
        title: "Things",
        parts: [
          {
            endpoint: "owners",
            component,
            roles: { title: ["ownerName"], subtitle: ["region"] },
            title: "Owners",
          },
        ],
        interleave: true,
      },
      ctx,
    ).draft;

  it("produces one widget rather than one per part", () => {
    const ctx = context();
    const result = buildAll(interleaved(ctx), ctx);
    expect(result.errors).toEqual([]);
    expect(result.widgets).toHaveLength(1);
  });

  it("reads every part as a source of that one widget", () => {
    const ctx = context();
    const widget = buildAll(interleaved(ctx), ctx).widgets[0];
    expect(widget?.sources.map((source) => source.op)).toEqual(["list", "owners"]);
    expect(widget?.combine).toMatchObject({ op: "union" });
  });

  /*
   * The heart of it. Two endpoints that share no field names arrive as rows
   * that do, because each renames its own fields onto the role.
   */
  it("renames each endpoint's own fields onto the shared role names", () => {
    const ctx = context();
    const widget = buildAll(interleaved(ctx), ctx).widgets[0];
    const renameOf = (as: string) =>
      widget?.sources
        .find((source) => source.as === as)
        ?.pipeline.find((step) => step.op === "rename");

    expect(renameOf("list")).toMatchObject({ fields: { name: "title", status: "subtitle" } });
    expect(renameOf("owners")).toMatchObject({
      fields: { ownerName: "title", region: "subtitle" },
    });
    expect(widget?.roles).toMatchObject({ title: "title", subtitle: "subtitle" });
  });

  it("carries only the columns the list draws", () => {
    const ctx = context();
    const widget = buildAll(interleaved(ctx), ctx).widgets[0];
    const select = widget?.sources[0]?.pipeline.find((step) => step.op === "select");
    expect(select).toMatchObject({ fields: ["name", "status"] });
  });

  /*
   * Without a badge the list is two kinds of record shuffled together and
   * indistinguishable, which is strictly worse than two widgets.
   */
  it("badges every row with where it came from", () => {
    const ctx = context();
    const widget = buildAll(interleaved(ctx), ctx).widgets[0];
    expect(widget?.highlights).toHaveLength(2);
    expect(widget?.highlights.map((entry) => entry.label)).toEqual(["Things", "Owners"]);
    expect(widget?.highlights[0]?.when).toContain("series ==");
  });

  it("says what it left out", () => {
    const ctx = context();
    expect(buildAll(interleaved(ctx), ctx).warnings.join(" ")).toContain(
      "only the fields all of them have",
    );
  });

  /*
   * A table has no honest way to decide that the properties' address and the
   * listings' rent are the same column. The result is a wide grid half full of
   * blanks, which reads as data having gone missing.
   */
  it("refuses a component whose columns cannot be aligned", () => {
    const ctx = context();
    const result = buildAll(interleaved(ctx, "table"), ctx);
    expect(result.widgets).toEqual([]);
    expect(result.errors.join(" ")).toContain("half");
  });

  it("refuses when a required role is missing on one part", () => {
    const ctx = context();
    const half = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "list",
        roles: { title: ["name"] },
        parts: [{ endpoint: "owners", component: "list" }],
        interleave: true,
      },
      ctx,
    ).draft;
    const result = buildAll(half, ctx);
    expect(result.widgets).toEqual([]);
    expect(result.errors.join(" ")).toContain("title");
  });

  /*
   * A role only some parts bind would leave those rows blank in that position,
   * which looks like a load failure rather than an absence. Dropping the role
   * is the honest version.
   */
  it("drops an optional role that not every part binds", () => {
    const ctx = context();
    const uneven = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "list",
        roles: { title: ["name"], subtitle: ["status"] },
        parts: [{ endpoint: "owners", component: "list", roles: { title: ["ownerName"] } }],
        interleave: true,
      },
      ctx,
    ).draft;
    const widget = buildAll(uneven, ctx).widgets[0];
    expect(widget?.roles["title"]).toBe("title");
    expect(widget?.roles["subtitle"]).toBeUndefined();
  });

  /*
   * A spec the schema accepts is not the same as a widget that works. This is
   * the one that matters: real rows from two endpoints that share no field
   * name, through the real runtime, arriving as one list.
   */
  it("really stacks both endpoints' rows into one list", () => {
    const ctx = context();
    const widget = buildAll(interleaved(ctx), ctx).widgets[0]!;
    const executed = executeWidget(widget, { list: FLAT, owners: OWNERS }, {
      now: Date.parse("2026-08-01T00:00:00Z"),
      params: {
        range: resolveRange({ preset: "12mo", now: Date.parse("2026-08-01T00:00:00Z") }),
        filters: {},
      },
    });

    expect(executed.errors).toEqual([]);
    // Four things and two owners, in one list.
    expect(executed.rows).toHaveLength(6);
    expect(executed.rows.map((row) => row["title"])).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "North",
      "South",
    ]);
    // And every row says which endpoint it came from.
    expect(new Set(executed.rows.map((row) => row["series"]))).toEqual(
      new Set(["Things", "Owners"]),
    );
  });

  it("ignores the flag for a setup of one widget", () => {
    const ctx = context();
    const alone = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "list",
        roles: { title: ["name"] },
        interleave: true,
      },
      ctx,
    ).draft;
    const result = buildAll(alone, ctx);
    expect(result.widgets).toHaveLength(1);
    // The ordinary single-widget path, not the union.
    expect(result.widgets[0]?.sources).toEqual([]);
  });
});

/**
 * Answering a question about the second widget.
 *
 * The reported failure, and it had three layers. `nextStepAcross` hands out
 * scoped ids — `p1:role:title` — and every path that consumed one was still
 * the unscoped version: the answer route, the chat action, and the card's own
 * patch builder. Each wrote the scoped string somewhere nothing reads it, so
 * the answer applied to nothing, the same question came back, and the card
 * redrew identically. From the outside: a flicker, and a flow that could
 * neither advance nor go back.
 */
describe("answering a scoped question", () => {
  const context = () => contextFor({ list: FLAT, owners: OWNERS }, { joins: [] });

  const twoParts = (ctx: ConciergeContext) =>
    revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "table",
        roles: { columns: ["name"] },
        title: "Things",
        // Roles before a title, because that is the order `ORDER` applies them
        // in — a part with nothing bound has no title step to set yet.
        parts: [
          {
            endpoint: "owners",
            component: "table",
            roles: { columns: ["ownerName"] },
            title: "Owners",
          },
        ],
      },
      ctx,
    ).draft;

  /** Roles hold one name or several; the question is which widget got it. */
  const bound = (draft: ReturnType<typeof twoParts>, index: number): string[] => {
    const value = partsOf(draft)[index]?.roles["columns"];
    return Array.isArray(value) ? value : value ? [value] : [];
  };

  it("applies an answer to the widget it was asked about", () => {
    const ctx = context();
    const draft = applyStepAcross(twoParts(ctx), "p1:role:columns", ["region"], ctx);
    expect(bound(draft, 1)).toEqual(["region"]);
    // And leaves the first widget exactly as it was.
    expect(bound(draft, 0)).toEqual(["name"]);
  });

  it("records a skip against the widget it was asked about", () => {
    const ctx = context();
    const draft = skipStepAcross(twoParts(ctx), "p1:drilldown");
    expect(partsOf(draft)[1]?.skipped).toContain("drilldown");
    expect(partsOf(draft)[0]?.skipped).not.toContain("drilldown");
  });

  it("moves the next question on rather than asking it again", () => {
    const ctx = context();
    /*
     * A second widget with nothing bound, so something really is blocking.
     * A fully answered setup has no next question at all in assisted mode,
     * which is right and makes for a test that proves nothing.
     */
    let draft = revise(
      newDraft("d", "", "assisted"),
      {
        endpoint: "list",
        component: "table",
        roles: { columns: ["name"] },
        parts: [{ endpoint: "owners", component: "table" }],
      },
      ctx,
    ).draft;

    const first = nextStepAcross(draft, ctx);
    expect(first).not.toBeNull();
    // The blocking question belongs to the second widget, and says so.
    expect(first!.id.startsWith("p1:")).toBe(true);

    draft = applyStepAcross(draft, first!.id, [first!.options[0]!.value], ctx);
    const second = nextStepAcross(draft, ctx);
    // The stuck flow was the same id coming back forever.
    expect(second?.id).not.toBe(first!.id);
  });

  /*
   * The third layer, and the subtlest. Part zero lives in two places once
   * `parts` is materialised, and `revise` only knew about one of them — so
   * every later edit to the FIRST widget was written to the top-level fields,
   * read back from a stale `parts[0]`, and appeared to do nothing.
   */
  it("keeps an edit to the first widget once a second exists", () => {
    const ctx = context();
    const started = twoParts(ctx);
    const edited = revise(started, { title: "Renamed" }, ctx).draft;

    expect(edited.title).toBe("Renamed");
    expect(partsOf(edited)[0]?.title).toBe("Renamed");
    // And the second widget is untouched by it.
    expect(partsOf(edited)[1]?.title).toBe("Owners");
  });

  it("routes a scoped patch to the right widget", () => {
    const ctx = context();
    const edited = revise(twoParts(ctx), { parts: [{ title: "Also renamed" }] }, ctx).draft;
    expect(partsOf(edited)[1]?.title).toBe("Also renamed");
    expect(partsOf(edited)[0]?.title).toBe("Things");
  });
});
