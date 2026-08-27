import type { AuthContext } from "@freebirdai/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newDraft } from "@freebirdai/dash-agent";
import { DRAFT_TTL_MS, ScratchDraftStore } from "../concierge/store.js";
import { type ChatDb, openChatDb, truncateChat } from "./db.js";

/**
 * The embedded database is the one local development and CI run, so these
 * exercise the same adapter, schema and SQL a hosted Postgres would.
 *
 * One instance is shared and truncated between cases: booting PGlite is a WASM
 * Postgres start-up and costs seconds, which a per-test instance would pay
 * over and over for no extra coverage.
 */

let db: ChatDb;

beforeAll(async () => {
  db = await openChatDb({ databaseUrl: undefined, inMemory: true });
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await truncateChat(db);
});

const alice: AuthContext = { userId: "alice" };
const bob: AuthContext = { userId: "bob" };

describe("chat storage", () => {
  it("applies the schema on open, so a fresh clone can boot", async () => {
    expect(db.kind).toBe("pglite");
    // Missing tables would throw here rather than return nothing.
    await expect(db.adapter.listTabs(alice)).resolves.toEqual([]);
  });

  it("round-trips a session and its messages in order", async () => {
    const session = await db.adapter.createSession({ title: "First" }, alice);

    await db.adapter.appendMessage(
      { sessionId: session.id, role: "user", content: "hello" },
      alice,
    );
    await db.adapter.appendMessage(
      { sessionId: session.id, role: "assistant", content: "hi back" },
      alice,
    );

    const messages = await db.adapter.listMessages(session.id, alice);
    expect(messages.map((m) => m.content)).toEqual(["hello", "hi back"]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("keeps tool payloads intact through JSONB", async () => {
    const session = await db.adapter.createSession({}, alice);
    await db.adapter.appendMessage(
      {
        sessionId: session.id,
        role: "tool",
        content: "[action] completed",
        toolName: "widgets:add_widget",
        toolPayload: { status: "completed", args: { title: "Leases" } },
      },
      alice,
    );

    const [message] = await db.adapter.listMessages(session.id, alice);
    expect(message?.toolName).toBe("widgets:add_widget");
    expect(message?.toolPayload).toMatchObject({ status: "completed" });
  });

  /*
   * The isolation the hosted version depends on.
   *
   * `@freebirdai/adapters-db-postgres` ships with no tests of its own, and every
   * query scopes with `.$if(!!auth.userId, …)` — a falsy user id drops the
   * filter rather than matching nothing. Dash is single-user locally, but this
   * is the adapter a managed deployment would run, so the boundary is asserted
   * here rather than assumed.
   */
  describe("owner scoping", () => {
    it("hides one user's session from another", async () => {
      const session = await db.adapter.createSession({ title: "Alice's" }, alice);
      expect(await db.adapter.getSession(session.id, alice)).not.toBeNull();
      expect(await db.adapter.getSession(session.id, bob)).toBeNull();
    });

    it("returns no messages to a user who does not own the session", async () => {
      const session = await db.adapter.createSession({}, alice);
      await db.adapter.appendMessage(
        { sessionId: session.id, role: "user", content: "private" },
        alice,
      );
      expect(await db.adapter.listMessages(session.id, bob)).toEqual([]);
    });

    it("refuses to append to a session another user owns", async () => {
      const session = await db.adapter.createSession({}, alice);
      await expect(
        db.adapter.appendMessage({ sessionId: session.id, role: "user", content: "hi" }, bob),
      ).rejects.toThrow();
    });

    it("does not delete another user's session", async () => {
      const session = await db.adapter.createSession({}, alice);
      await db.adapter.deleteSession(session.id, bob);
      expect(await db.adapter.getSession(session.id, alice)).not.toBeNull();
    });

    it("scopes tabs to their owner", async () => {
      await db.adapter.createTab(
        { title: "Alice board", layout: { gridCols: 12, cells: [] } },
        alice,
      );
      expect(await db.adapter.listTabs(alice)).toHaveLength(1);
      expect(await db.adapter.listTabs(bob)).toEqual([]);
    });

    /*
     * The fail-open case, recorded as a fact rather than a wish.
     *
     * With no user id there is nothing to scope by and the adapter returns
     * everything. That is exactly why the server must always supply a concrete
     * identity; this test exists so the behaviour is documented and any future
     * change to it is a deliberate one.
     */
    it("scopes by nothing when no identity is supplied", async () => {
      const session = await db.adapter.createSession({}, alice);
      expect(await db.adapter.getSession(session.id, {})).not.toBeNull();
    });
  });
});

describe("scratch storage", () => {
  /*
   * The scratch table is what makes a half-finished guided setup survive a
   * restart. Its own isolation rules are tested upstream against the adapter;
   * these confirm the table exists in Dash's inlined schema and that the draft
   * store on top of it round-trips.
   */
  const scope = "board-1";

  it("applies the scratch migration, so a draft has somewhere to live", async () => {
    const store = new ScratchDraftStore(db.adapter, alice);
    // A missing table would throw here rather than answer null.
    await expect(store.get(scope)).resolves.toBeNull();
  });

  it("round-trips a draft", async () => {
    const store = new ScratchDraftStore(db.adapter, alice);
    const draft = newDraft("d1", "leases by status");
    await store.put(scope, draft);

    const found = await store.get(scope);
    expect(found?.id).toBe("d1");
    expect(found?.intent).toBe("leases by status");
  });

  it("keeps one user's setup out of another's on the same board", async () => {
    // Two people can legitimately have a draft against a board with the same
    // id — which is exactly why identity is part of the scratch key rather
    // than a filter that a blank auth context can drop.
    await new ScratchDraftStore(db.adapter, alice).put(scope, newDraft("alice-draft", "a"));
    await new ScratchDraftStore(db.adapter, bob).put(scope, newDraft("bob-draft", "b"));

    expect((await new ScratchDraftStore(db.adapter, alice).get(scope))?.id).toBe("alice-draft");
    expect((await new ScratchDraftStore(db.adapter, bob).get(scope))?.id).toBe("bob-draft");
  });

  it("clears only the caller's own draft", async () => {
    await new ScratchDraftStore(db.adapter, alice).put(scope, newDraft("alice-draft", "a"));
    await new ScratchDraftStore(db.adapter, bob).put(scope, newDraft("bob-draft", "b"));

    await new ScratchDraftStore(db.adapter, alice).clear(scope);

    expect(await new ScratchDraftStore(db.adapter, alice).get(scope)).toBeNull();
    expect((await new ScratchDraftStore(db.adapter, bob).get(scope))?.id).toBe("bob-draft");
  });

  it("forgets a draft nobody came back to", async () => {
    /*
     * Written by a store whose clock sits a full TTL in the past, so the row
     * lands with an expiry that has already gone by. The clock is injected on
     * the *write* only — the read compares against the database's own NOW(),
     * which is the point: no sweep has to have run for an expired draft to
     * stop being readable.
     */
    const stale = new ScratchDraftStore(db.adapter, alice, () => Date.now() - DRAFT_TTL_MS - 1000);
    await stale.put(scope, newDraft("d1", "a"));

    expect(await new ScratchDraftStore(db.adapter, alice).get(scope)).toBeNull();
  });
});

/**
 * Durability needs a real directory, so it pays its own start-up cost and runs
 * apart from the shared in-memory instance above.
 */
describe("chat storage durability", () => {
  it(
    "survives reopening the same data directory",
    async () => {
      const dir = `.dash/test-chat-db-${Date.now()}`;
      const first = await openChatDb({ databaseUrl: undefined, dataDir: dir });
      const session = await first.adapter.createSession({ title: "Durable" }, alice);
      await new ScratchDraftStore(first.adapter, alice).put("board-1", {
        ...newDraft("mid-setup", "leases"),
        connection: "api",
        op: "list",
        component: "table",
        roles: { columns: ["Name"] },
      });
      await first.adapter.appendMessage(
        { sessionId: session.id, role: "user", content: "still here?" },
        alice,
      );
      await first.close();

      const second = await openChatDb({ databaseUrl: undefined, dataDir: dir });
      try {
        const messages = await second.adapter.listMessages(session.id, alice);
        expect(messages.map((m) => m.content)).toEqual(["still here?"]);

        // The point of putting drafts here rather than in memory: eight
        // answers into a setup, a restart is not a reason to start again.
        const reopened = await new ScratchDraftStore(second.adapter, alice).get("board-1");
        expect(reopened?.id).toBe("mid-setup");
        expect(reopened?.roles).toEqual({ columns: ["Name"] });
      } finally {
        await second.close();
        const { rmSync } = await import("node:fs");
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
