import type { Principal } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { CalendarService } from "../calendar/service.js";
import { MemoryCalendarStore } from "../calendar/store.js";
import { calendarActions, calendarKnowledge, type CalendarChatOps } from "./calendar-actions.js";

const NOW = Date.parse("2026-10-08T15:00:00.000Z");
const owner: Principal = { userId: "sam", workspaceId: "acme", role: "owner", kind: "member" };
const viewer: Principal = { userId: "vi", workspaceId: "acme", role: "viewer", kind: "member" };
const ctxFor = (principal: Principal | null) => ({ auth: { extra: principal ? { principal } : {} } }) as never;

const build = () => {
  const store = new MemoryCalendarStore();
  let n = 0;
  const calendar = new CalendarService({ store, now: () => NOW, newId: () => `n${++n}` });
  const ops: CalendarChatOps = {
    agents: [
      { id: "maint", name: "Maintenance", archived: false },
      { id: "old", name: "Old", archived: true },
    ],
    now: () => NOW,
    mayManage: async (principal) => principal.role !== "viewer",
    list: (options) => calendar.list(options),
    create: (principal, input) => calendar.create(principal, input),
  };
  const action = (id: string) => calendarActions(ops).find((one) => one.id === id)!;
  return { store, calendar, ops, action };
};

describe("calendar chat actions", () => {
  it("reads the next week by default, without finished entries, naming agents", async () => {
    const { calendar, action } = build();
    await calendar.create(owner, { title: "Walkthrough", at: "2026-10-09T15:00:00.000Z", owner: { kind: "agent", id: "maint" } });
    await calendar.create(owner, { title: "Far off", at: "2026-10-30T15:00:00.000Z" });
    const finished = await calendar.create(owner, { title: "Done already", at: "2026-10-10T15:00:00.000Z" });
    await calendar.setStatus(owner, finished.id, "done");

    const list = action("list_calendar");
    expect(list.requiresConfirmation).toBe("none");
    const answer = (await list.handler({}, ctxFor(owner))) as { count: number; entries: Array<{ title: string; owner?: string }> };
    expect(answer.count).toBe(1);
    expect(answer.entries[0]).toMatchObject({ title: "Walkthrough", owner: "Maintenance" });
    const all = (await list.handler({ days: 30, includeFinished: true }, ctxFor(owner))) as { count: number };
    expect(all.count).toBe(3);
  });

  it("adds an entry on a card, for those who may change the calendar, onto a live agent's calendar", async () => {
    const { store, action } = build();
    const add = action("add_calendar_entry");
    expect(add.requiresConfirmation).toBe("preview");
    const args = { title: "Vendor insurance due", at: "2026-10-15", deadline: true, ownerAgentId: "maint" };
    expect(add.preview!(args, ctxFor(owner))).toMatchObject({ title: 'Add "Vendor insurance due" to the calendar', rows: expect.arrayContaining([{ label: "Calendar", value: "Maintenance" }]) });

    expect(await add.authorize!(args, ctxFor(viewer))).toMatchObject({ ok: false, status: 403 });
    expect(await add.authorize!({ ...args, ownerAgentId: "old" }, ctxFor(owner))).toMatchObject({ ok: false, status: 404 });
    expect(await add.authorize!(args, ctxFor(null))).toMatchObject({ ok: false, status: 401 });
    expect(await add.authorize!(args, ctxFor(owner))).toBe(true);

    const made = (await add.handler(args, ctxFor(owner))) as { added: boolean; id: string };
    expect(made.added).toBe(true);
    expect(await store.get(made.id)).toMatchObject({ kind: "deadline", allDay: true, owner: { kind: "agent", id: "maint" }, createdBy: "sam" });
  });

  it("tells the chat what time it is, since it cannot see a clock", () => {
    expect(calendarKnowledge(build().ops)[0]!.text).toContain("2026-10-08T15:00:00.000Z");
  });
});
