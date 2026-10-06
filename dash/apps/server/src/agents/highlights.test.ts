import { fakeLlm } from "@freebirdai/dash-agent";
import { agentSchema, composeResponsePrompt, type Principal } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { ownerPolicy } from "../identity/policy.js";
import { activeHighlights, checkHighlights } from "./highlights.js";
import { AgentService } from "./service.js";
import { MemoryAgentStore } from "./store.js";

const at = "2026-10-06T00:00:00.000Z";
const highlight = (id: string, label: string, description: string, enabled = true) => ({
  id,
  kind: "highlight",
  label,
  description,
  enabled,
});
const agent = agentSchema.parse({
  id: "collector",
  name: "Collector",
  color: 1,
  createdAt: at,
  updatedAt: at,
  tools: [
    highlight("legal", "Legal threat", "They mention a lawyer, court or legal action."),
    highlight("move", "Moving out", "They say they are moving out or ending their stay."),
    highlight("off", "Off", "Anything", false),
    { id: "follow", kind: "schedule_follow_up", mode: "auto" },
  ],
});

describe("highlights", () => {
  it("checks a message against every active highlight in one call", async () => {
    const llm = fakeLlm([{ args: { matches: [{ id: "legal", reason: "They say they will call their lawyer." }] } }]);
    const matches = await checkHighlights(llm, agent, "If this isn't fixed I'm calling my lawyer.");
    expect(matches).toEqual([{ highlight: "legal", title: "Legal threat", reason: "They say they will call their lawyer." }]);
    expect(llm.calls).toHaveLength(1);
    const sent = llm.calls[0]!.messages.map((one) => one.content).join("\n");
    expect(sent).toContain("Moving out");
    expect(sent).not.toContain("Anything");
  });

  it("drops a match on a highlight it was never given, and makes no call with none to check", async () => {
    const llm = fakeLlm([{ args: { matches: [{ id: "invented", reason: "x" }] } }]);
    expect(await checkHighlights(llm, agent, "hello")).toEqual([]);
    const none = fakeLlm([]);
    expect(await checkHighlights(none, { tools: [] }, "hello")).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });

  it("stays out of the reply prompt", () => {
    expect(activeHighlights(agent).map((one) => one.id)).toEqual(["legal", "move"]);
    const prompt = composeResponsePrompt({ agent });
    expect(prompt).not.toContain("Legal threat");
    expect(prompt).toContain("schedule a follow-up");
  });

  it("needs a title and something to watch for", async () => {
    const owner: Principal = { userId: "o", workspaceId: "acme", role: "owner", kind: "member" };
    const service = new AgentService({ store: new MemoryAgentStore(), policy: ownerPolicy, hasConnection: () => true });
    await expect(
      service.create(owner, { name: "A", color: 1, tools: [{ ...highlight("h", "", "x"), mode: "auto", scope: {}, whenToUse: "", denyReply: "" } as never] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create(owner, { name: "B", color: 1, tools: [{ ...highlight("h", "Legal", "lawyers"), mode: "auto", scope: {}, whenToUse: "", denyReply: "" } as never] }),
    ).resolves.toBeDefined();
  });
});
