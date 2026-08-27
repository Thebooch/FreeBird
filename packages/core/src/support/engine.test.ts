import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildReportIssueTool,
  parseReportIssueArgs,
  classificationFromDraft,
  buildTicketDraftPayload,
  REPORT_ISSUE_TOOL_NAME,
} from "./engine.js";
import { buildSupportPrompt } from "./prompt.js";
import { ticketDraftSchema, ticketSeveritySchema, ticketTypeSchema } from "./ticket.js";
import { deriveTicketPreview } from "./preview.js";

describe("ticket schemas", () => {
  it("accepts a valid bug draft with severity", () => {
    const draft = ticketDraftSchema.parse({
      type: "bug",
      severity: "high",
      title: "Dashboard latency",
      summary: "Pages load slowly after login",
      stepsToReproduce: "Log in and open receptionist",
      attemptedRemedies: ["Checked network tab"],
    });
    expect(draft.type).toBe("bug");
    expect(draft.severity).toBe("high");
  });

  it("accepts a valid feature draft with complexity as severity", () => {
    const draft = ticketDraftSchema.parse({
      type: "feature",
      severity: "medium",
      title: "New setting for call routing",
      summary: "User wants a toggle for warm transfer default",
      desiredOutcome: "A setting in receptionist routes",
    });
    expect(draft.type).toBe("feature");
    expect(draft.severity).toBe("medium");
  });

  it("rejects invalid severity enum", () => {
    const result = ticketDraftSchema.safeParse({
      type: "bug",
      severity: "critical",
      title: "x",
      summary: "y",
    });
    expect(result.success).toBe(false);
  });

  it("severity schema only allows low, medium, high", () => {
    expect(ticketSeveritySchema.options).toEqual(["low", "medium", "high"]);
    expect(ticketTypeSchema.options).toEqual(["bug", "feature", "behavior"]);
  });
});

describe("buildReportIssueTool", () => {
  it("exposes report_issue with ticketDraftSchema", () => {
    const tool = buildReportIssueTool();
    expect(tool.name).toBe(REPORT_ISSUE_TOOL_NAME);
    expect(tool.schema).toBe(ticketDraftSchema);
  });

  it("parses LLM tool args", () => {
    const raw = {
      type: "bug",
      severity: "low",
      title: "Typo in greeting",
      summary: "Greeting shows wrong property name",
    };
    const draft = parseReportIssueArgs(raw);
    expect(draft).not.toBeNull();
    expect(classificationFromDraft(draft!)).toEqual({
      type: "bug",
      severity: "low",
    });
  });

  it("rejects malformed args", () => {
    expect(parseReportIssueArgs({ type: "bug" })).toBeNull();
  });
});

describe("buildTicketDraftPayload", () => {
  it("builds preview and classification", () => {
    const draft = ticketDraftSchema.parse({
      type: "feature",
      severity: "high",
      title: "Bulk export calls",
      summary: "Export all call logs to CSV",
      desiredOutcome: "CSV download from call log",
    });
    const payload = buildTicketDraftPayload("draft_1", draft, {
      subject: { callId: "abc" },
    });
    expect(payload.draftId).toBe("draft_1");
    expect(payload.preview.title).toContain("Feature request");
    expect(payload.preview.rows.some((r) => r.label === "Complexity")).toBe(
      true,
    );
    expect(payload.subject).toEqual({ callId: "abc" });
  });
});

describe("deriveTicketPreview", () => {
  it("labels severity for bugs and complexity for features", () => {
    const bugPreview = deriveTicketPreview({
      type: "bug",
      severity: "medium",
      title: "Broken",
      summary: "It fails",
    });
    expect(bugPreview.rows.find((r) => r.label === "Severity")?.value).toBe(
      "medium",
    );

    const featPreview = deriveTicketPreview({
      type: "feature",
      severity: "low",
      title: "Add tooltip",
      summary: "Show help on hover",
    });
    expect(featPreview.rows.find((r) => r.label === "Complexity")?.value).toBe(
      "low",
    );
  });

  it("labels behavior tickets with severity and includes observed response", () => {
    const draft = ticketDraftSchema.parse({
      type: "behavior",
      severity: "high",
      title: "Agent leaked instructions",
      summary: "The agent pasted its system prompt instead of answering",
      observedResponse: "You are a helpful assistant... (raw prompt)",
    });
    const preview = deriveTicketPreview(draft);
    expect(preview.title).toContain("Agent behavior report");
    expect(preview.rows.find((r) => r.label === "Type")?.value).toBe(
      "Agent behavior",
    );
    expect(preview.rows.find((r) => r.label === "Severity")?.value).toBe(
      "high",
    );
    expect(
      preview.rows.some((r) => r.label === "Observed response"),
    ).toBe(true);
  });
});

describe("buildSupportPrompt", () => {
  it("includes remedy-first and escalation guidance", () => {
    const prompt = buildSupportPrompt();
    expect(prompt).toContain("Remedy-first");
    expect(prompt).toContain("report_issue");
    expect(prompt).toContain("severity/impact");
    expect(prompt).toContain("implementation complexity");
  });

  it("appends host-specific guidance", () => {
    const prompt = buildSupportPrompt("Try receptionist actions first.");
    expect(prompt).toContain("Try receptionist actions first.");
  });
});

describe("tool schema OpenAI-safe", () => {
  it("uses plain z.object for report_issue (no root transform)", () => {
    const tool = buildReportIssueTool();
    expect(tool.schema).toBeInstanceOf(z.ZodObject);
  });
});
