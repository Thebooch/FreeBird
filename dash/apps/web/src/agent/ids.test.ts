import { describe, expect, it } from "vitest";
import { newRuleId, newToolId, usableRules } from "./ids.js";

describe("ids for an agent's tools and rules", () => {
  it("are readable and never collide", () => {
    expect(newToolId("look_up_record", [])).toBe("look-up-record");
    expect(newToolId("look_up_record", ["look-up-record", "look-up-record-2"])).toBe("look-up-record-3");
    expect(newRuleId(["rule"])).toBe("rule-2");
  });

  it("drop a rule with no trigger or nowhere to look", () => {
    const rules = [
      { trigger: "an address", sources: [1] },
      { trigger: "  ", sources: [1] },
      { trigger: "x", sources: [] },
    ];
    expect(usableRules(rules)).toEqual([rules[0]]);
  });
});
