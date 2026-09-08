import { describe, expect, it } from "vitest";
import { describeFilters, parseFilters } from "./onscreen.js";

const header = (value: unknown): string => encodeURIComponent(JSON.stringify(value));

describe("parseFilters", () => {
  it("reads what the client reported", () => {
    expect(parseFilters(header({ tasks: ["Status: Open, Overdue"] }))).toEqual({
      tasks: ["Status: Open, Overdue"],
    });
  });

  it("treats anything unreadable as no filters rather than an error", () => {
    /*
     * The same rule `parseView` follows: a newer client, a truncated header or
     * a stale tab should cost this one line of context and nothing more. A
     * chat turn must not fail because a header was odd.
     */
    for (const value of [undefined, "", "not json", "%%%", header([1, 2]), header("text"), header(null)]) {
      expect(parseFilters(value)).toEqual({});
    }
  });

  it("drops entries that are not lists of strings", () => {
    expect(parseFilters(header({ a: "Status: Open", b: [1, 2], c: ["ok"] }))).toEqual({
      c: ["ok"],
    });
  });

  it("refuses a key that would walk the prototype", () => {
    // Untrusted input keying a plain object used as a map.
    const parsed = parseFilters(header({ __proto__: ["x"], constructor: ["y"], real: ["z"] }));
    expect(parsed).toEqual({ real: ["z"] });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("bounds how much a header can put in the prompt", () => {
    const parsed = parseFilters(
      header({ w: ["a", "b", "c", "d", "e", "f"], x: ["y".repeat(400)] }),
    );
    expect(parsed["w"]).toHaveLength(4);
    expect(parsed["x"]?.[0]).toHaveLength(120);
  });
});

describe("describeFilters", () => {
  it("says nothing when nothing is filtering", () => {
    // The line only appears when it would change an answer.
    expect(describeFilters({}, () => "Tasks")).toBe("");
  });

  it("names the widget and warns that counts are of the filtered rows", () => {
    /*
     * The failure this exists to stop: a widget's rows rebuild identically on
     * the server whatever the reader picked — a facet never reaches the API —
     * so without this the assistant answers over every row while the person
     * asking can see a fraction of them.
     */
    const line = describeFilters({ tasks: ["Status: Open"] }, () => "Work orders");
    expect(line).toContain("Work orders");
    expect(line).toContain("Status: Open");
    expect(line).toContain("filtered");
  });

  it("falls back to the widget id when the title is gone", () => {
    expect(describeFilters({ tasks: ["Status: Open"] }, () => undefined)).toContain("tasks");
  });
});
