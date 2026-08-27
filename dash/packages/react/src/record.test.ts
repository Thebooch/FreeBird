import { widgetSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { detailPanes, headerPane, recordPane, relatedPanes } from "./detail.js";
import { missingTokens } from "./RecordPage.jsx";

const widget = (drilldown: Record<string, unknown>) =>
  widgetSchema.parse({
    id: "applicants",
    title: "Applicants",
    component: "table",
    source: { connection: "buildium", op: "list" },
    drilldown,
  });

describe("detailPanes", () => {
  const spec = widget({
    op: "byId",
    params: { applicantId: "{{row.Id}}" },
    header: { title: "FirstName", status: "Status", facts: ["Id"] },
    groups: [{ title: "Identity", fields: ["FirstName", "Email"] }],
    related: [
      { id: "apps", title: "Applications", op: "apps", display: "tab" },
      { id: "notes", title: "Notes", op: "notes", display: "section" },
    ],
  });

  it("builds a header pane over the same endpoint as the record", () => {
    const panes = detailPanes(spec);
    const header = headerPane(panes);
    expect(header?.spec.component).toBe("recordHeader");
    // Same op as the record, so the cache serves both from one request rather
    // than the identity block costing a second call.
    expect(header?.spec.source?.op).toBe("byId");
    expect(header?.spec.roles).toEqual({ title: "FirstName", status: "Status", facts: ["Id"] });
  });

  it("carries field groups on the record pane only", () => {
    const panes = detailPanes(spec);
    expect(recordPane(panes)?.groups).toEqual([
      { title: "Identity", fields: ["FirstName", "Email"] },
    ]);
    expect(headerPane(panes)?.groups).toBeUndefined();
  });

  it("never lets a pane carry the parent's drill-down", () => {
    // A pane that kept it would re-open the record you are already looking at,
    // from inside itself.
    for (const pane of detailPanes(spec)) {
      expect(pane.spec.drilldown, pane.id).toBeUndefined();
    }
  });

  it("omits the header when the drill-down declares none", () => {
    const plain = widget({ op: "byId", params: { id: "{{row.Id}}" } });
    expect(headerPane(detailPanes(plain))).toBeUndefined();
  });
});

describe("relatedPanes", () => {
  const panes = detailPanes(
    widget({
      op: "byId",
      params: { applicantId: "{{row.Id}}" },
      related: [
        { id: "apps", title: "Applications", op: "apps", display: "tab" },
        { id: "notes", title: "Notes", op: "notes", display: "section" },
      ],
    }),
  );

  it("splits tabs from sections where there is room", () => {
    const { tabs, sections } = relatedPanes(panes, true);
    expect(tabs.map((pane) => pane.id)).toEqual(["apps"]);
    expect(sections.map((pane) => pane.id)).toEqual(["notes"]);
  });

  /*
   * One tab is a heading wearing a control's clothes: it hides nothing and
   * costs a click to discover. So a lone collection stacks in the drawer even
   * though it asked to be a tab.
   */
  it("stacks a lone collection in the drawer rather than tabbing it", () => {
    const { tabs, sections } = relatedPanes(panes, false);
    expect(tabs).toEqual([]);
    expect(sections.map((pane) => pane.id)).toEqual(["apps", "notes"]);
  });

  it("tabs them in the drawer once there are two, which is when tabs earn a click", () => {
    const several = detailPanes(
      widget({
        op: "byId",
        params: { applicantId: "{{row.Id}}" },
        related: [
          { id: "apps", title: "Applications", op: "apps", display: "tab" },
          { id: "docs", title: "Documents", op: "docs", display: "tab" },
          { id: "notes", title: "Notes", op: "notes", display: "section" },
        ],
      }),
    );
    const { tabs, sections } = relatedPanes(several, false);
    expect(tabs.map((pane) => pane.id)).toEqual(["apps", "docs"]);
    expect(sections.map((pane) => pane.id)).toEqual(["notes"]);
  });

  it("never treats the record or the header as related", () => {
    const { tabs, sections } = relatedPanes(panes, true);
    const ids = [...tabs, ...sections].map((pane) => pane.id);
    expect(ids).not.toContain("record");
    expect(ids).not.toContain("header");
  });
});

describe("missingTokens", () => {
  /*
   * A link carries the record's id and nothing else. Firing the request anyway
   * produces a 404 that reads like a broken credential, which is a far worse
   * thing to hand somebody than a sentence explaining the link.
   */
  it("names the fields a link cannot supply", () => {
    expect(missingTokens({ applicantId: "{{row.Id}}", scope: "{{row.LastName}}" }, { Id: 5 })).toEqual(
      ["LastName"],
    );
  });

  it("is empty when the row has everything", () => {
    expect(missingTokens({ applicantId: "{{row.Id}}" }, { Id: 5 })).toEqual([]);
  });

  it("ignores tokens that are not row fields", () => {
    expect(missingTokens({ since: "{{range.start}}", id: "{{row.Id}}" }, { Id: 1 })).toEqual([]);
  });

  it("treats a null as missing, not as present", () => {
    expect(missingTokens({ id: "{{row.Id}}" }, { Id: null })).toEqual(["Id"]);
  });

  it("reads a token that carries a filter", () => {
    expect(missingTokens({ id: "{{ row.Id | number }}" }, {})).toEqual(["Id"]);
  });
});
