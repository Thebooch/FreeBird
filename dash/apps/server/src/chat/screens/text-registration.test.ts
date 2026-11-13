import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import { createComponentRegistry, deriveActionPreview, runAction } from "@freebirdai/core";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { Principal } from "@freebirdai/dash-spec";
import { FAKE_SECRET, FakeCarrier } from "@freebirdai/phone";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toJsonSchema } from "../../llm.js";
import { PhoneLines } from "../../phone/lines.js";
import { MemoryRegistrationStore, RegistrationService, type DraftSource } from "../../phone/registration.js";
import { MemoryPhoneUsageStore } from "../../phone/usage.js";
import { SpecStore } from "../../store.js";
import { agentOf } from "../../workflows/testing.js";
import { SCREENS } from "./common.js";
import { FIELD_HELP, KNOWLEDGE_PACK, textRegistrationScreen } from "./text-registration.js";

/*
 * The text-registration screen: what the chat may read and do on the
 * wizard, and what it never does.
 */

const owner: Principal = { userId: "sam", workspaceId: "acme", role: "owner", kind: "member" };
const viewer: Principal = { userId: "vic", workspaceId: "acme", role: "viewer", kind: "member" };
const authOf = (principal: Principal) => ({ userId: principal.userId, extra: { principal } });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-text-registration-screen-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const world = async (name: string, sources: DraftSource[] = []) => {
  const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 4)), join(dir, name, "vault.json"));
  const store = new SpecStore(join(dir, name, "d"), join(dir, name, "c"), join(dir, name, "r"));
  const carrier = new FakeCarrier({ numbers: ["+15550100100"] });
  const lines = new PhoneLines({
    connections: { list: () => store.listConnections(), get: (id) => store.getConnection(id), put: (spec) => store.putConnection(spec), remove: async (id) => store.deleteConnection(id) },
    keys,
    providers: { fake: carrier.open },
    usage: new MemoryPhoneUsageStore(),
    policy: { can: () => ({ ok: true }) },
    agents: { get: async () => agentOf() },
    now: () => 0,
  });
  const line = await lines.create({ provider: "fake", number: "+15550100100", keys: { secret: FAKE_SECRET } });
  const llm: LlmAdapter = { defaultModel: "scripted", generate: async () => ({ text: '{"use":"ACCOUNT_NOTIFICATION","description":"Visit reminders.","samples":["Your visit is tomorrow.","See you soon."]}', toolCalls: [] }), stream: async function* () {} };
  const registration = new RegistrationService({
    store: new MemoryRegistrationStore(),
    keys,
    lines,
    providers: { fake: carrier.open },
    scan: async (url) => ({ url, reachable: true, https: true, showsName: true, noSharing: true, checkedByDefault: false, consentWithTerms: false, prohibited: [] }),
    sources: async () => sources,
    llm: () => llm,
    hostedPages: () => ({ pageUrl: "https://p.example/texts", privacyUrl: "https://p.example/texts/privacy", termsUrl: "https://p.example/texts/terms" }),
    now: () => 0,
  });
  const changed = vi.fn();
  const screen = textRegistrationScreen({ may: async (principal) => principal.role !== "viewer", now: () => 0, changed, registration, lines, sources: async () => sources });
  const registry = createComponentRegistry();
  registry.register(screen);
  /** One action as `/actions/confirm` runs it: its result, or what stopped it. */
  const run = async (actionId: string, args: Record<string, unknown>, principal: Principal = owner): Promise<unknown> => {
    const outcome = await runAction(registry, { componentId: SCREENS.textRegistration.id, actionId, args, auth: authOf(principal), sessionId: "s1", recordId: "r1" });
    return outcome.kind === "executed" ? (outcome as { result: unknown }).result : outcome;
  };
  return { screen, registry, registration, line, run, changed };
};

describe("the text-registration screen", () => {
  it("knows the pack, marked as a draft, and offers exactly the plan's actions plus reading the draft", async () => {
    const { screen } = await world("shape");
    expect(KNOWLEDGE_PACK[0]).toMatch(/Last reviewed: .*draft/);
    expect(KNOWLEDGE_PACK.map((one) => one.split("\n")[0])).toEqual([
      expect.stringMatching(/^Last reviewed/),
      "## How to answer",
      "## What registration is",
      "## Time and cost",
      "## Step 1: Your business",
      "## Step 2: Who to contact",
      "## Step 3: What you'll text",
      "## Step 4: How people agree",
      "## Step 5: Check and submit",
      "## Step 6: Status",
      "## After approval",
      "## Quick answers",
    ]);
    expect(KNOWLEDGE_PACK.join(" ").toLowerCase()).not.toContain("toll-free");
    expect(screen.actions!.map((one) => [one.id, one.requiresConfirmation])).toEqual([
      ["read_draft", "none"],
      ["explain_field", "none"],
      ["check_draft", "none"],
      ["explain_rejection", "none"],
      ["redraft_use", "none"],
      ["fill_field", "preview"],
    ]);
    for (const action of screen.actions!) expect(() => toJsonSchema(action.schema as never), action.id).not.toThrow();
    expect(screen.actions!.some((one) => /submit/i.test(one.id))).toBe(false);
  });

  it("reads the live draft with the EIN masked, and explains the focused field", async () => {
    const { registration, line, run } = await world("read");
    await registration.setEin(line.id, "12-3456789");
    const read = (await run("read_draft", {})) as { draft: { business: { ein: string } }; problems: unknown[] };
    expect(read.draft.business.ein).toBe("••-•••6789");
    expect(JSON.stringify(read)).not.toContain("3456789");
    expect(read.problems.length).toBeGreaterThan(0);
    expect(await run("explain_field", { field: "ein" })).toMatchObject({ help: FIELD_HELP["ein"], now: "••-•••6789" });
  });

  it("runs the checks and explains a rejection without submitting", async () => {
    const { run } = await world("check");
    expect(await run("check_draft", {})).toMatchObject({ ready: false, problems: expect.arrayContaining([expect.objectContaining({ rule: "required-filled" })]) });
    expect(await run("explain_rejection", { code: "30794" })).toMatchObject({ field: "legalName" });
  });

  it("redrafts only into the proposal box: the campaign is untouched until Use this", async () => {
    const { registration, line, run } = await world("redraft", [{ kind: "workflow", name: "Reminders", words: ["Your visit is tomorrow."] }]);
    const proposed = (await run("redraft_use", { instructions: "Keep it short." })) as { proposed: boolean; from: string[] };
    expect(proposed).toMatchObject({ proposed: true, from: ["Reminders"] });
    expect((await registration.view(line.id)).campaign).toMatchObject({ description: "", drafted: { accepted: false } });
  });

  it("fills a non-sensitive field on a card, and never the EIN, the legal name or a confirmation", async () => {
    const { registry, registration, line, run, changed } = await world("fill");
    const def = registry.getAction(SCREENS.textRegistration.id, "fill_field")!;
    for (const field of ["ein", "legalName", "confirmed", "businessType"]) {
      const refused = await def.preflight!({ field, value: "x" } as never, { auth: authOf(owner), sessionId: "s1" });
      expect(refused, field).toMatchObject({ ok: false, message: expect.stringMatching(/never takes|type it/) });
    }
    expect(await def.preflight!({ field: "contactEmail", value: "not an email" } as never, { auth: authOf(owner), sessionId: "s1" })).toMatchObject({ ok: false });
    const card = deriveActionPreview(def, { field: "frequency", value: "One text per visit", line: line.id }, { componentId: SCREENS.textRegistration.id });
    expect(card).toMatchObject({ title: expect.stringContaining("frequency") });
    await run("fill_field", { field: "frequency", value: "One text per visit" });
    expect((await registration.view(line.id)).campaign.frequency).toBe("One text per visit");
    expect(changed).toHaveBeenCalled();
    expect(await run("fill_field", { field: "frequency", value: "x" }, viewer)).toMatchObject({ kind: "unauthorized" });
  });
});
