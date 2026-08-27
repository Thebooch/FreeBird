import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ActionContext,
  AuthContext,
  DataSourceContext,
  TicketDraft,
} from "@freebirdai/core";
import {
  compileServerRegistry,
  DEFAULT_MANIFEST_GRID,
  isLocalActionResult,
  parseManifest,
  type RegistrationManifest,
} from "./index.js";

const manifest: RegistrationManifest = parseManifest({
  version: 1,
  siteId: "fb_site1",
  components: [
    {
      id: "openingHours",
      title: "Opening hours",
      description: "Weekly opening hours.",
      tags: ["hours"],
      kind: "dom-region",
      source: { selector: "#hours" },
      knowledge: ["Closed Mondays."],
      fields: [{ name: "saturday", description: "Saturday hours" }],
      actions: [
        {
          id: "show_hours",
          description: "Scroll to the hours",
          kind: "local-dom",
          directive: "scroll-to",
        },
        {
          id: "fill_contact",
          description: "Fill the contact form",
          kind: "local-dom",
          directive: "fill-form",
        },
      ],
    },
    {
      id: "bookingForm",
      title: "Booking form",
      description: "Reservation form.",
      kind: "dom-region",
      source: { selector: "form#book" },
      actions: [
        {
          id: "request_booking",
          description: "File a booking request",
          kind: "server",
          server: { type: "file-ticket", tags: ["booking"] },
          args: [
            { name: "partySize", type: "number", description: "Guests", required: true },
          ],
        },
        {
          id: "notify_kitchen",
          description: "Notify the kitchen",
          kind: "server",
          server: { type: "webhook", webhook: "kitchen" },
        },
        {
          id: "notify_unknown",
          description: "Calls an unconfigured webhook",
          kind: "server",
          server: { type: "webhook", webhook: "nope" },
        },
      ],
    },
  ],
});

const dsCtx: DataSourceContext<AuthContext> = {
  tabId: "tab1",
  auth: {},
  runAt: new Date(),
  props: {},
};
const actionCtx: ActionContext<AuthContext> = { auth: {}, sessionId: "sess1" };

describe("compileServerRegistry", () => {
  it("registers every manifest component with snapshot-backed dataSource", async () => {
    const getSnapshot = vi.fn().mockResolvedValue({ text: "Mon–Fri 9–17" });
    const registry = compileServerRegistry(manifest, {
      getSnapshot,
      fileTicket: vi.fn(),
      resolveWebhook: () => null,
    });
    expect(registry.list().map((c) => c.id).sort()).toEqual([
      "bookingForm",
      "openingHours",
    ]);
    const hours = registry.getOrThrow("openingHours");
    expect(hours.grid).toEqual(DEFAULT_MANIFEST_GRID);
    expect(hours.knowledge?.map((k) => k.text)).toEqual([
      "Closed Mondays.",
      'Field "saturday": Saturday hours',
    ]);
    await expect(hours.dataSource!(dsCtx)).resolves.toEqual({ text: "Mon–Fri 9–17" });
    expect(getSnapshot).toHaveBeenCalledWith("openingHours", dsCtx);
  });

  it("compiles top-level manifest knowledge into the registry's site knowledge", () => {
    const withKnowledge = parseManifest({
      version: 1,
      components: manifest.components,
      knowledge: [
        "shorthand string fact",
        {
          id: "kb_hours01",
          title: "Hours",
          text: "Open 9-5 weekdays.",
          source: { page: "/about", selector: "#hours", heading: "Opening hours" },
          origin: "ingested",
        },
      ],
    });
    const registry = compileServerRegistry(withKnowledge, {
      getSnapshot: () => ({}),
      fileTicket: vi.fn(),
      resolveWebhook: () => null,
    });
    const items = registry.listKnowledge();
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ text: "shorthand string fact" });
    // origin is Studio provenance — stripped before reaching the runtime.
    expect(items[1]).toEqual({
      id: "kb_hours01",
      title: "Hours",
      text: "Open 9-5 weekdays.",
      source: { page: "/about", selector: "#hours", heading: "Opening hours" },
    });
    expect(registry.getKnowledgeItem("kb_hours01")?.text).toBe("Open 9-5 weekdays.");
  });

  it("compiles rich component-level knowledge items", () => {
    const withRich = parseManifest({
      version: 1,
      components: [
        {
          id: "hero",
          title: "Hero",
          description: "Top section.",
          kind: "dom-region",
          source: { selector: "#hero" },
          knowledge: ["shorthand", { text: "rich fact", category: "Tips" }],
        },
      ],
    });
    const registry = compileServerRegistry(withRich, { getSnapshot: () => ({}) });
    expect(registry.getOrThrow("hero").knowledge).toEqual([
      { text: "shorthand" },
      { text: "rich fact", category: "Tips" },
    ]);
  });

  it("is idempotent — recompiling upserts instead of throwing", () => {
    const hooks = {
      getSnapshot: () => ({}),
      fileTicket: vi.fn(),
      resolveWebhook: () => null,
    };
    const registry = compileServerRegistry(manifest, hooks);
    expect(() =>
      compileServerRegistry(manifest, { ...hooks, registry }),
    ).not.toThrow();
    expect(registry.list()).toHaveLength(2);
  });

  it("compiles local-dom actions into directive-returning handlers", async () => {
    const registry = compileServerRegistry(manifest, {
      getSnapshot: () => ({}),
      fileTicket: vi.fn(),
      resolveWebhook: () => null,
    });
    const action = registry.getAction("openingHours", "show_hours")!;
    expect(action.requiresConfirmation).toBe("none");
    const result = await action.handler({}, actionCtx);
    expect(isLocalActionResult(result)).toBe(true);
    expect(result).toMatchObject({
      kind: "freebird.local-dom",
      directive: "scroll-to",
      componentId: "openingHours",
      selector: "#hours",
    });
  });

  it("threads source.page into the local-dom action result when the component sets it", async () => {
    const withPage: RegistrationManifest = parseManifest({
      version: 1,
      components: [
        {
          id: "contactHours",
          title: "Contact hours",
          description: "Hours on the contact page.",
          kind: "dom-region",
          source: { selector: "#hours", page: "/contact" },
          actions: [
            {
              id: "show_hours",
              description: "Scroll to the hours",
              kind: "local-dom",
              directive: "scroll-to",
            },
          ],
        },
      ],
    });
    const registry = compileServerRegistry(withPage, {
      getSnapshot: () => ({}),
      fileTicket: vi.fn(),
      resolveWebhook: () => null,
    });
    const action = registry.getAction("contactHours", "show_hours")!;
    const result = await action.handler({}, actionCtx);
    expect(result).toMatchObject({ selector: "#hours", page: "/contact" });
  });

  it("omits page from the result when the component doesn't set one", async () => {
    const registry = compileServerRegistry(manifest, {
      getSnapshot: () => ({}),
      fileTicket: vi.fn(),
      resolveWebhook: () => null,
    });
    const action = registry.getAction("openingHours", "show_hours")!;
    const result = await action.handler({}, actionCtx);
    expect(result).not.toHaveProperty("page");
  });

  it("defaults fill-form to preview confirmation with a record args schema", () => {
    const registry = compileServerRegistry(manifest, {
      getSnapshot: () => ({}),
      fileTicket: vi.fn(),
      resolveWebhook: () => null,
    });
    const action = registry.getAction("openingHours", "fill_contact")!;
    expect(action.requiresConfirmation).toBe("preview");
    expect(action.schema.safeParse({ name: "Ada", guests: 4 }).success).toBe(true);
  });

  it("routes file-ticket actions through the hook with a valid TicketDraft", async () => {
    const fileTicket = vi.fn().mockResolvedValue({ externalId: "T-1" });
    const registry = compileServerRegistry(manifest, {
      getSnapshot: () => ({}),
      fileTicket,
      resolveWebhook: () => null,
    });
    const action = registry.getAction("bookingForm", "request_booking")!;
    expect(action.schema.safeParse({}).success).toBe(false); // partySize required
    const result = await action.handler({ partySize: 4 }, actionCtx);
    expect(result).toEqual({ externalId: "T-1" });
    const draft = fileTicket.mock.calls[0]![0] as TicketDraft;
    expect(draft.type).toBe("feature");
    expect(draft.relatedComponentIds).toEqual(["bookingForm"]);
    expect(draft.tags).toContain("booking");
    expect(fileTicket.mock.calls[0]![1]).toEqual({
      componentId: "bookingForm",
      actionId: "request_booking",
      args: { partySize: 4 },
    });
  });

  it("delivers webhooks with an HMAC signature and rejects unresolved names", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const registry = compileServerRegistry(manifest, {
      getSnapshot: () => ({}),
      fileTicket: vi.fn(),
      resolveWebhook: (name) =>
        name === "kitchen" ? { url: "https://hooks.test/k", secret: "s3cret" } : null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const ok = registry.getAction("bookingForm", "notify_kitchen")!;
    await expect(ok.handler({}, actionCtx)).resolves.toEqual({
      delivered: true,
      status: 200,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://hooks.test/k");
    const expected = createHmac("sha256", "s3cret")
      .update(init.body as string)
      .digest("hex");
    expect(init.headers["x-freebird-signature"]).toBe(expected);
    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({
      componentId: "bookingForm",
      actionId: "notify_kitchen",
    });

    const bad = registry.getAction("bookingForm", "notify_unknown")!;
    await expect(bad.handler({}, actionCtx)).rejects.toThrow(/not configured/);
  });

  it("fails fast when hooks don't cover declared server actions", () => {
    expect(() =>
      compileServerRegistry(manifest, { getSnapshot: () => ({}) }),
    ).toThrow(/fileTicket hook/);
  });
});
