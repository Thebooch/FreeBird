import { describe, expect, it } from "vitest";
import {
  isAffirmativeSupportConfirmation,
  isSupportDraftCancellation,
} from "./confirm.js";

describe("isAffirmativeSupportConfirmation", () => {
  it("accepts common confirmations", () => {
    expect(isAffirmativeSupportConfirmation("Great, looks good")).toBe(true);
    expect(isAffirmativeSupportConfirmation("yes please")).toBe(true);
    expect(isAffirmativeSupportConfirmation("file the ticket")).toBe(true);
    expect(isAffirmativeSupportConfirmation("go ahead")).toBe(true);
  });

  it("rejects cancellations and empty", () => {
    expect(isAffirmativeSupportConfirmation("")).toBe(false);
    expect(isAffirmativeSupportConfirmation("no wait")).toBe(false);
    expect(isAffirmativeSupportConfirmation("cancel")).toBe(false);
  });
});

describe("isSupportDraftCancellation", () => {
  it("detects cancel phrases", () => {
    expect(isSupportDraftCancellation("cancel")).toBe(true);
    expect(isSupportDraftCancellation("no don't file")).toBe(true);
    expect(isSupportDraftCancellation("never mind")).toBe(true);
  });
});
