import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createComponentRegistry } from "../components/registry.js";
import { buildReviewItemsTool, REVIEW_ITEMS_TOOL_NAME } from "./tool.js";
import { buildReviewPrompt } from "./prompt.js";
import { ALL_REVIEW_DISPOSITIONS } from "./types.js";

const makeRegistry = () => {
  const r = createComponentRegistry();
  r.register({
    id: "callReview",
    title: "Call Review",
    description: "Review recent calls",
    grid: { minW: 6, minH: 4 },
    review: { itemNoun: "call", guidance: "Flag angry callers" },
  });
  r.register({
    id: "plainWidget",
    title: "Plain",
    description: "No review",
    grid: { minW: 4, minH: 3 },
  });
  return r;
};

describe("registry.listReviewable", () => {
  it("returns only components with a review capability", () => {
    const reviewable = makeRegistry().listReviewable();
    expect(reviewable).toHaveLength(1);
    const first = reviewable[0]!;
    expect(first.componentId).toBe("callReview");
    expect(first.itemNoun).toBe("call");
    expect(first.dispositions).toEqual(ALL_REVIEW_DISPOSITIONS);
    expect(first.guidance).toBe("Flag angry callers");
  });

  it("respects componentIds filter", () => {
    const reviewable = makeRegistry().listReviewable({
      componentIds: ["plainWidget"],
    });
    expect(reviewable).toHaveLength(0);
  });
});

describe("buildReviewItemsTool", () => {
  it("constrains componentId to reviewable ids", () => {
    const reviewable = makeRegistry().listReviewable();
    const tool = buildReviewItemsTool(reviewable);
    expect(tool.name).toBe(REVIEW_ITEMS_TOOL_NAME);
    const ok = tool.schema.safeParse({ componentId: "callReview" });
    expect(ok.success).toBe(true);
    const bad = tool.schema.safeParse({ componentId: "nope" });
    expect(bad.success).toBe(false);
  });

  it("falls back to string componentId when none registered", () => {
    const tool = buildReviewItemsTool([]);
    const ok = tool.schema.safeParse({ componentId: "anything" });
    expect(ok.success).toBe(true);
  });

  it("uses a plain object schema (OpenAI-safe)", () => {
    const tool = buildReviewItemsTool([]);
    expect(tool.schema).toBeInstanceOf(z.ZodObject);
  });
});

describe("buildReviewPrompt", () => {
  it("is empty with no reviewable components", () => {
    expect(buildReviewPrompt([])).toBe("");
  });

  it("lists reviewable components and dispositions", () => {
    const reviewable = makeRegistry().listReviewable();
    const prompt = buildReviewPrompt(reviewable);
    expect(prompt).toContain("Review mode");
    expect(prompt).toContain("callReview");
    expect(prompt).toContain("report_issue");
    expect(prompt).toContain("review_items");
  });
});
