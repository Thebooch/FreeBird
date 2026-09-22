import { describe, expect, it } from "vitest";
import { connectionSchema, entitySchema, resourceSchema } from "@freebirdai/dash-spec";
import { fakeLlm } from "./llm.js";
import {
  analyzeOnboarding,
  designOnboardingCategory,
  onboardingFingerprint,
  onboardingMetadata,
  validateOnboardingLayout,
} from "./onboarding.js";

const metadata = (title = "Buildium") => ({
  title,
  ops: connectionSchema.parse({
    id: "test",
    title,
    kind: "rest",
    ops: [
      {
        id: "leases",
        title: "Leases",
        description: "Property lease agreements",
        path: "/leases",
        headers: { secret: "never-send" },
      },
      { id: "tasks", title: "Maintenance", description: "Maintenance work orders", path: "/tasks" },
    ],
  }).ops,
  resources: ["leases", "tasks"].map((id) => resourceSchema.parse({ id, title: id, listOp: id })),
  entities: ["leases", "tasks"].map((id) =>
    entitySchema.parse({
      id,
      resource: id,
      name: { one: id, many: id },
      kind: "work",
      identity: { field: "Id" },
      display: { title: ["Title"] },
      fields: [
        { path: "Id", kinds: ["number"], semantic: "identifier", visibility: "hidden" },
        { path: "Title", kinds: ["string"], visibility: "primary" },
        { path: "Status", kinds: ["string"], visibility: "primary" },
      ],
    }),
  ),
});
const analysis = {
  purpose: "Property management software",
  categoryQuestion: "Which areas matter to you?",
  organizationQuestion: "Together or separate?",
  categories: [
    { id: "leasing", title: "Leasing", description: "Manage leases", opIds: ["leases"] },
    { id: "maintenance", title: "Maintenance", description: "Manage repairs", opIds: ["tasks"] },
  ],
};

describe("onboarding generation", () => {
  it("grounds categories in endpoints and keeps credentials out of prompts", async () => {
    const llm = fakeLlm([{ args: analysis }]);
    const template = await analyzeOnboarding(llm, metadata());
    expect(template.categories.map((category) => category.resourceIds)).toEqual([
      ["leases"],
      ["tasks"],
    ]);
    expect(JSON.stringify(llm.calls)).not.toContain("never-send");
    expect(llm.calls[0]?.messages[0]?.content).toContain("UNTRUSTED");
    expect(onboardingMetadata(metadata())).not.toHaveProperty("headers");
  });
  it("repairs unknown categories once and rejects repeated invented endpoints", async () => {
    const bad = { ...analysis, categories: [{ ...analysis.categories[0], opIds: ["imaginary"] }] };
    const repair = fakeLlm([{ args: bad }, { args: analysis }]);
    expect((await analyzeOnboarding(repair, metadata())).categories).toHaveLength(2);
    expect(repair.calls).toHaveLength(2);
    const failed = fakeLlm([{ args: bad }]);
    await expect(analyzeOnboarding(failed, metadata())).rejects.toThrow(
      "Unknown category endpoint",
    );
    expect(failed.calls).toHaveLength(2);
  });
  it("compiles briefs and falls back to legal layout after two bad layout answers", async () => {
    const template = await analyzeOnboarding(fakeLlm([{ args: analysis }]), metadata());
    const llm = fakeLlm([
      {
        args: {
          widgets: [
            { entity: "leases", intent: "records", title: "Leases" },
            { entity: "leases", intent: "measure", title: "Lease count" },
          ],
        },
      },
      { args: { cells: [] } },
    ]);
    const category = await designOnboardingCategory(llm, metadata(), template.categories[0]!);
    expect(category.status).toBe("ready");
    expect(category.widgets.map((widget) => widget.component)).toEqual(["table", "stat"]);
    expect(validateOnboardingLayout(category.widgets, category.layout)).toEqual(category.layout);
    expect(category.widgets[0]?.source?.connection).toBe("onboarding-source");
    expect(llm.calls).toHaveLength(3);
  });
  it("rejects fabricated fields rather than accepting compiler fallbacks", async () => {
    const template = await analyzeOnboarding(fakeLlm([{ args: analysis }]), metadata());
    await expect(
      designOnboardingCategory(
        fakeLlm([
          {
            args: {
              widgets: [
                { entity: "leases", intent: "records", columns: ["Imaginary"], title: "Wrong" },
              ],
            },
          },
        ]),
        metadata(),
        template.categories[0]!,
      ),
    ).rejects.toThrow("Unknown field");
  });
  it("does not depend on property-management vocabulary", async () => {
    const input = metadata("Issue tracker");
    input.ops = connectionSchema.parse({
      id: "tracker",
      title: "Issue tracker",
      kind: "rest",
      ops: [
        { id: "issues", title: "Issues", path: "/issues", description: "Software issues and bugs" },
      ],
    }).ops;
    input.resources = [resourceSchema.parse({ id: "issues", title: "Issues", listOp: "issues" })];
    input.entities = [
      entitySchema.parse({
        ...input.entities[0],
        id: "issues",
        resource: "issues",
        name: { one: "Issue", many: "Issues" },
      }),
    ];
    const template = await analyzeOnboarding(
      fakeLlm([
        {
          args: {
            ...analysis,
            purpose: "Software issue tracking",
            categories: [
              {
                id: "engineering",
                title: "Engineering",
                description: "Track work",
                opIds: ["issues"],
              },
            ],
          },
        },
      ]),
      input,
    );
    const category = await designOnboardingCategory(
      fakeLlm([
        { args: { widgets: [{ entity: "issues", intent: "records", title: "Issues" }] } },
        { args: { cells: [] } },
      ]),
      input,
      template.categories[0]!,
    );
    expect(category.widgets[0]?.source?.op).toBe("issues");
    expect(JSON.stringify(template)).not.toContain("Buildium");
  });
  it("invalidates templates when metadata changes", () => {
    const before = metadata();
    const after = metadata();
    after.ops[0]!.description = "New meaning";
    expect(onboardingFingerprint(before)).not.toBe(onboardingFingerprint(after));
  });
});
