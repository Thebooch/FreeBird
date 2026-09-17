// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompletenessNotice, EntityRecordList } from "./EntityBrowser.jsx";

describe("entity browser presentation", () => {
  it("starts with no restrictions and distinguishes typed values when filtering loaded records", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () =>
        root.render(
          createElement(EntityRecordList, {
            onOpen: () => {},
            filters: [{ field: "state", label: "Status" }],
            records: [0, "0", false].map((value, index) => ({
              ref: { connection: "account", entity: "task", keys: { id: index }, context: {} },
              title: `Record ${index}`,
              fields: [{ id: "state", label: "Status", value, advanced: false }],
            })),
          }),
        ),
      );
      expect(container.querySelectorAll("li")).toHaveLength(3);
      const select = container.querySelector("select")!;
      expect(select.value).toBe("");
      await act(async () => {
        select.value = "0";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.querySelectorAll("li")).toHaveLength(1);
      expect(container.querySelector("li")?.textContent).toContain("Record 0");
      await act(async () => {
        select.value = "false";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.querySelector("li")?.textContent).toContain("Record 2");
      await act(async () => {
        select.value = "";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.querySelectorAll("li")).toHaveLength(3);
      expect(container.textContent).toContain("Filter these loaded records");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousEnvironment;
    }
  });
  it("shows semantic labels and descriptions with navigable references, keeping IDs out of ordinary columns", () => {
    const html = renderToStaticMarkup(
      createElement(EntityRecordList, {
        onOpen: () => {},
        records: [
          {
            ref: {
              connection: "account",
              entity: "task",
              keys: { id: "hidden-task-id" },
              context: {},
            },
            title: "Repair entrance light",
            fields: [
              { id: "id", label: "Identifier", value: "hidden-task-id", advanced: true },
              {
                id: "vendor",
                label: "Assigned vendor",
                description: "The company responsible for this task.",
                value: "Sample Electric",
                advanced: false,
                reference: {
                  connection: "account",
                  entity: "vendor",
                  keys: { id: "hidden-vendor-id" },
                  context: {},
                },
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain("Repair entrance light");
    expect(html).toContain("Sample Electric");
    expect(html).toContain("The company responsible");
    expect(html).not.toContain("hidden-task-id");
    expect(html).not.toContain("hidden-vendor-id");
    expect(html).toContain("Search these loaded records");
  });
  it("does not label incomplete results as complete totals", () => {
    const html = renderToStaticMarkup(
      createElement(CompletenessNotice, {
        completeness: { status: "partial", reason: "Bounded", scope: "query" },
      }),
    );
    expect(html).toContain("There may be more records");
    expect(renderToStaticMarkup(createElement(CompletenessNotice, {}))).toContain(
      "has not been confirmed",
    );
  });
});
