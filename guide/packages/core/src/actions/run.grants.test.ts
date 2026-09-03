import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  actionGrantSubject,
  createComponentRegistry,
  grantForActionArgs,
  prepareActionArgs,
  runAction,
  type ActionGrantPort,
  type Grant,
} from "@freebirdai/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory confirmation store, standing in for the host's DbAdapter. */
const grantStore = (grants: Grant[] = []): ActionGrantPort & { put: (g: Grant) => void } => {
  const bySubject = new Map(grants.map((g) => [g.subject, g]));
  return {
    read: (subject) => bySubject.get(subject) ?? null,
    put: (grant) => void bySubject.set(grant.subject, grant),
  };
};

const makeRegistry = (handler = vi.fn(async () => ({ ok: true }))) => {
  const registry = createComponentRegistry();
  registry.register({
    id: "invoice",
    title: "Invoice",
    description: "Invoice",
    grid: { minW: 4, minH: 3 },
    actions: [
      {
        id: "send",
        description: "send an invoice",
        schema: z.object({
          to: z.string(),
          amount: z.number(),
          currency: z.string().default("USD"),
        }),
        handler,
      },
    ],
  });
  return { registry, handler };
};

const base = {
  componentId: "invoice",
  actionId: "send",
  auth: { userId: "u1" },
  sessionId: "s1",
  recordId: "rec1",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAction grant enforcement", () => {
  it("executes normally when no grant port is supplied", async () => {
    const { registry, handler } = makeRegistry();
    const outcome = await runAction(registry, {
      ...base,
      args: { to: "a@b.com", amount: 100 },
    });
    expect(outcome.kind).toBe("executed");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses when nothing was ever confirmed", async () => {
    const { registry, handler } = makeRegistry();
    const outcome = await runAction(registry, {
      ...base,
      args: { to: "a@b.com", amount: 100 },
      grants: grantStore(),
    });
    expect(outcome).toMatchObject({ kind: "grant_required", reason: "absent" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("executes when the confirmation covers these exact arguments", async () => {
    const { registry, handler } = makeRegistry();
    const args = { to: "a@b.com", amount: 100 };

    // What the host does at confirm time: normalize, then grant over the
    // normalized shape it displayed.
    const prepared = await prepareActionArgs(registry, { ...base, args });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;

    const store = grantStore();
    store.put(grantForActionArgs({ ...base, normalizedArgs: prepared.normalizedArgs }));

    const outcome = await runAction(registry, { ...base, args, grants: store });
    expect(outcome.kind).toBe("executed");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses when the arguments changed after the user confirmed", async () => {
    const { registry, handler } = makeRegistry();
    const shown = { to: "a@b.com", amount: 100 };
    const prepared = await prepareActionArgs(registry, { ...base, args: shown });
    if (prepared.kind !== "ready") throw new Error("expected ready");

    const store = grantStore([
      grantForActionArgs({ ...base, normalizedArgs: prepared.normalizedArgs }),
    ]);

    // The amount moved between the preview and the confirm.
    const outcome = await runAction(registry, {
      ...base,
      args: { to: "a@b.com", amount: 999 },
      grants: store,
    });
    expect(outcome).toMatchObject({ kind: "grant_required", reason: "digest-changed" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("is insensitive to argument key order", async () => {
    const { registry } = makeRegistry();
    const prepared = await prepareActionArgs(registry, {
      ...base,
      args: { to: "a@b.com", amount: 100 },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready");
    const store = grantStore([
      grantForActionArgs({ ...base, normalizedArgs: prepared.normalizedArgs }),
    ]);

    const outcome = await runAction(registry, {
      ...base,
      args: { amount: 100, to: "a@b.com" },
      grants: store,
    });
    expect(outcome.kind).toBe("executed");
  });

  it("covers schema defaults, so an unstated default does not revoke consent", async () => {
    // `currency` defaults to USD during validation. The grant is taken over
    // the normalized args, so the digest matches even though the caller never
    // sent the field.
    const { registry } = makeRegistry();
    const prepared = await prepareActionArgs(registry, {
      ...base,
      args: { to: "a@b.com", amount: 100 },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready");
    expect(prepared.normalizedArgs["currency"]).toBe("USD");

    const store = grantStore([
      grantForActionArgs({ ...base, normalizedArgs: prepared.normalizedArgs }),
    ]);
    const outcome = await runAction(registry, {
      ...base,
      args: { to: "a@b.com", amount: 100 },
      grants: store,
    });
    expect(outcome.kind).toBe("executed");
  });

  it("cannot replay one action's confirmation against another", async () => {
    const { registry } = makeRegistry();
    const prepared = await prepareActionArgs(registry, {
      ...base,
      args: { to: "a@b.com", amount: 100 },
    });
    if (prepared.kind !== "ready") throw new Error("expected ready");

    // A grant recorded under a different action, same record id.
    const store = grantStore([
      grantForActionArgs({
        componentId: "invoice",
        actionId: "void",
        recordId: "rec1",
        normalizedArgs: prepared.normalizedArgs,
      }),
    ]);

    const outcome = await runAction(registry, {
      ...base,
      args: { to: "a@b.com", amount: 100 },
      grants: store,
    });
    expect(outcome).toMatchObject({ kind: "grant_required", reason: "absent" });
  });

  it("scopes the subject by action and record", () => {
    expect(actionGrantSubject("invoice", "send", "rec1")).toBe("action:invoice/send#rec1");
    expect(actionGrantSubject("invoice", "send", "rec2")).not.toBe(
      actionGrantSubject("invoice", "send", "rec1"),
    );
  });

  it("does not read host state for an unconfirmed action", async () => {
    const readCurrent = vi.fn(async () => ({ amount: 1 }));
    const registry = createComponentRegistry();
    registry.register({
      id: "invoice",
      title: "Invoice",
      description: "Invoice",
      grid: { minW: 4, minH: 3 },
      actions: [
        {
          id: "send",
          description: "send",
          schema: z.object({ amount: z.number() }),
          readCurrent,
          handler: async () => ({}),
        },
      ],
    });

    const outcome = await runAction(registry, {
      ...base,
      args: { amount: 5 },
      grants: grantStore(),
    });
    expect(outcome.kind).toBe("grant_required");
    expect(readCurrent).not.toHaveBeenCalled();
  });
});
