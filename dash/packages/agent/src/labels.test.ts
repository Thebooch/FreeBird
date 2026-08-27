import { describe, expect, it } from "vitest";
import type { LlmAdapter } from "./llm.js";
import {
  LABEL_SYSTEM_PROMPT,
  acceptLabel,
  buildLabelPrompt,
  collectFieldNames,
  dropCollisions,
  labelFields,
  type LabelInput,
} from "./labels.js";

/**
 * A deliberately vendor-neutral fixture. The pass has to work on any API, so
 * the tests must not encode one — the same guard `pick.test.ts` and
 * `review.test.ts` carry.
 */
const input: LabelInput = {
  apiTitle: "Widget API",
  ops: [
    {
      id: "list_things",
      title: "Retrieve all things",
      fields: [
        { name: "Id", kinds: ["number"], nullable: false },
        { name: "CurrentNumberOfOccupants", kinds: ["number"], nullable: false },
        { name: "LastUpdatedDateTime", kinds: ["string"], nullable: true, format: "iso8601" },
        { name: "Category.Name", kinds: ["string"], nullable: true },
      ],
    },
    {
      id: "list_others",
      title: "Retrieve all others",
      fields: [
        { name: "Id", kinds: ["number"], nullable: false },
        { name: "ThingId", kinds: ["number"], nullable: false, description: "The thing it is for." },
      ],
    },
  ],
};

const fakeLlm = (labels: Array<{ name: string; label: string }>): LlmAdapter => ({
  defaultModel: "fake",
  stream: () => {
    throw new Error("not used");
  },
  generate: async () => ({
    text: "",
    toolCalls: [{ id: "1", name: "name_fields", args: { labels } }],
  }),
});

describe("collectFieldNames", () => {
  it("returns one entry per distinct name, commonest first", () => {
    const found = collectFieldNames(input);
    expect(found.map((field) => field.name)).toEqual([
      "Id",
      "Category.Name",
      "CurrentNumberOfOccupants",
      "LastUpdatedDateTime",
      "ThingId",
    ]);
    // `Id` is on both endpoints; everything else is on one.
    expect(found[0]?.count).toBe(2);
    expect(found[0]?.seenOn).toEqual(["Retrieve all things", "Retrieve all others"]);
  });

  it("keeps the format and description any endpoint declared", () => {
    const found = collectFieldNames(input);
    const updated = found.find((field) => field.name === "LastUpdatedDateTime");
    expect(updated?.format).toBe("iso8601");
    const thing = found.find((field) => field.name === "ThingId");
    expect(thing?.description).toBe("The thing it is for.");
  });
});

describe("buildLabelPrompt", () => {
  it("names each field with its shape and where it was seen", () => {
    const prompt = buildLabelPrompt(input, collectFieldNames(input));
    expect(prompt).toContain("CurrentNumberOfOccupants");
    expect(prompt).toContain("· iso8601");
    expect(prompt).toContain("on Retrieve all things");
    expect(prompt).toContain("the spec says: The thing it is for.");
  });

  it("names no vendor and no domain vocabulary in the system prompt", () => {
    const lowered = LABEL_SYSTEM_PROMPT.toLowerCase();
    for (const word of ["buildium", "stripe", "github", "lease", "tenant", "invoice"]) {
      expect(lowered).not.toContain(word);
    }
  });
});

describe("acceptLabel", () => {
  it("takes a real improvement", () => {
    expect(acceptLabel("CurrentNumberOfOccupants", "Occupants")).toBe("Occupants");
  });

  it("refuses a label that only repeats what humanLabel already produces", () => {
    // `humanLabel("unitNumber")` is already "Unit number" — storing it says nothing.
    expect(acceptLabel("unitNumber", "Unit number")).toBeNull();
    expect(acceptLabel("Id", "Id")).toBeNull();
  });

  it("refuses a sentence, markup, and anything too long", () => {
    expect(acceptLabel("Amount", "The amount that was charged.")).toBeNull();
    expect(acceptLabel("Amount", "{{amount}}")).toBeNull();
    expect(acceptLabel("Amount", "a".repeat(60))).toBeNull();
    expect(acceptLabel("Amount", "   ")).toBeNull();
  });

  it("collapses whitespace rather than refusing over it", () => {
    expect(acceptLabel("PostedOnDateTime", "Posted  on")).toBe("Posted on");
  });
});

describe("dropCollisions", () => {
  it("keeps one label where two fields on an endpoint would share it", () => {
    const collide: LabelInput = {
      apiTitle: "Widget API",
      ops: [
        {
          id: "list_things",
          title: "Retrieve all things",
          fields: [
            { name: "Owner", kinds: ["object"], nullable: true },
            { name: "Owner.Id", kinds: ["number"], nullable: true },
          ],
        },
      ],
    };
    const { labels, dropped } = dropCollisions(
      { Owner: "Owner", "Owner.Id": "Owner" },
      collide,
    );
    expect(labels).toEqual({ Owner: "Owner" });
    expect(dropped[0]).toContain("Owner.Id");
  });

  it("leaves a shared label alone when no single endpoint carries both", () => {
    const apart: LabelInput = {
      apiTitle: "Widget API",
      ops: [
        { id: "a", title: "A", fields: [{ name: "Alpha", kinds: ["string"], nullable: false }] },
        { id: "b", title: "B", fields: [{ name: "Beta", kinds: ["string"], nullable: false }] },
      ],
    };
    const { labels } = dropCollisions({ Alpha: "Name", Beta: "Name" }, apart);
    expect(labels).toEqual({ Alpha: "Name", Beta: "Name" });
  });
});

describe("labelFields", () => {
  it("stores the labels the model proposed", async () => {
    const result = await labelFields(
      fakeLlm([
        { name: "CurrentNumberOfOccupants", label: "Occupants" },
        { name: "LastUpdatedDateTime", label: "Last updated" },
        { name: "ThingId", label: "Thing" },
      ]),
      input,
    );
    expect(result.labels).toEqual({
      CurrentNumberOfOccupants: "Occupants",
      LastUpdatedDateTime: "Last updated",
      ThingId: "Thing",
    });
    expect(result.errors).toEqual([]);
  });

  it("discards a name that was never offered rather than approximating it", async () => {
    const result = await labelFields(
      fakeLlm([
        { name: "OccupantCount", label: "Occupants" },
        { name: "Category.Name", label: "Category" },
      ]),
      input,
    );
    expect(result.labels).toEqual({ "Category.Name": "Category" });
    expect(result.skipped.join(" ")).toContain("was not offered");
  });

  it("salvages the good rows when one is malformed", async () => {
    const result = await labelFields(
      fakeLlm([
        { name: "ThingId", label: "Thing" },
        { name: 7, label: "Nonsense" } as unknown as { name: string; label: string },
      ]),
      input,
    );
    expect(result.labels).toEqual({ ThingId: "Thing" });
    expect(result.skipped.join(" ")).toContain("malformed");
  });

  it("reports a failed call rather than throwing, so a partial pass survives", async () => {
    const angry: LlmAdapter = {
      defaultModel: "fake",
      stream: () => {
        throw new Error("not used");
      },
      generate: async () => {
        throw new Error("upstream said no");
      },
    };
    const result = await labelFields(angry, input);
    expect(result.labels).toEqual({});
    expect(result.errors[0]).toContain("upstream said no");
  });

  it("says nothing when the model answers without calling the tool", async () => {
    const chatty: LlmAdapter = {
      defaultModel: "fake",
      stream: () => {
        throw new Error("not used");
      },
      generate: async () => ({ text: "Sure, here are some labels!", toolCalls: [] }),
    };
    const result = await labelFields(chatty, input);
    expect(result.labels).toEqual({});
    expect(result.errors[0]).toContain("without calling the tool");
  });
});
