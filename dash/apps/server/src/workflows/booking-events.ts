import { createHash } from "node:crypto";
import type { BookingEvent, WorkflowCase, WorkflowSpec } from "@freebirdai/dash-spec";
import type { BookingStore } from "../bookings/store.js";
import type { ContactService } from "../contacts/service.js";
import { CaseBusy, type WorkflowEngine } from "./engine.js";
import type { WorkflowBookings, WorkflowEnv } from "./env.js";
import { RevisionConflict } from "./store.js";

/**
 * Delivering the bookings' outbox: what a booking change sets off, after it
 * is written down.
 *
 * For each event, in order:
 * 1. the calendar mirror is brought up to date (it is also updated as the
 *    change is made; this makes sure);
 * 2. a cancellation ends the open cases of workflows set to stop then;
 * 3. every case waiting on `booking:<id>` is woken with the event — an
 *    Approve a booking step reads the answer, a wait reads what they did;
 * 4. workflows whose `booking` trigger takes the event open a case, its id
 *    made from the workflow and the event, so delivering twice opens once;
 * 5. the contact's counts move (bookings, cancellations, no-shows);
 * 6. the event is marked delivered.
 *
 * An event that fails part way is tried again on the next pass; every step
 * above is safe to repeat.
 */

const shortHash = (value: string): string => createHash("sha1").update(value).digest("hex").slice(0, 16);

export interface BookingDispatchDeps {
  readonly env: WorkflowEnv;
  readonly engine: WorkflowEngine;
  readonly store: BookingStore;
  readonly bookings: WorkflowBookings;
  readonly contacts: ContactService;
}

export class BookingDispatcher {
  private running: Promise<number> | null = null;

  constructor(private readonly deps: BookingDispatchDeps) {}

  /** One pass over what is waiting. A pass already going is joined, not doubled. */
  deliver(limit = 100): Promise<number> {
    if (this.running) return this.running;
    this.running = this.pass(limit).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(limit: number): Promise<number> {
    let delivered = 0;
    for (const event of await this.deps.store.undelivered(limit)) {
      try {
        await this.one(event);
        await this.deps.store.markDelivered(event.id);
        delivered++;
      } catch (error) {
        this.deps.env.onEvent?.({ type: "case.error", case: `booking:${event.booking}`, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return delivered;
  }

  private async one(event: BookingEvent): Promise<void> {
    const { env, engine, store, bookings, contacts } = this.deps;
    const booking = await store.get(event.booking);
    if (!booking) return;
    await bookings.service.mirror(booking);
    const workflows = (await env.store.list()).filter(
      (one): one is WorkflowSpec & { trigger: Extract<WorkflowSpec["trigger"], { kind: "booking" }> } => one.trigger.kind === "booking" && one.enabled && !one.parked,
    );

    /* Cancelled: the cases of workflows set to stop then end first, so nothing below wakes them. A workflow that cancelled it itself goes on. */
    if (event.kind === "cancelled") {
      const cancelledBy = event.payload["by"] as { kind?: string; id?: string } | undefined;
      for (const workflow of workflows.filter((one) => one.trigger.endWhenCancelled && !(cancelledBy?.kind === "workflow" && cancelledBy.id === one.id))) {
        const open: WorkflowCase[] = [...(await env.cases.list({ workflow: workflow.id, status: "waiting", limit: 1000 })), ...(await env.cases.list({ workflow: workflow.id, status: "running", limit: 1000 }))];
        for (const one of open) {
          if (one.rowKey !== booking.id || (one.start.bookingEvent ?? "").endsWith(":cancelled")) continue;
          await engine.cancel(one.id).catch(() => undefined);
        }
      }
    }

    /*
     * Every case waiting on the booking hears it, each handed the event
     * directly: a booking may have several workflows waiting on it at once.
     * A busy case leaves the event undelivered, to be handed over again;
     * the steps read the booking itself, so hearing it twice is harmless.
     */
    const payload = { ...event.payload, event: event.kind, status: booking.status, booking: booking.id };
    for (const one of await env.cases.waitingOn(`booking:${booking.id}`)) {
      await engine.advance(one.id, { resume: { kind: "event", payload } });
    }

    const starting = workflows.filter((one) => one.trigger.events.includes(event.kind) && (one.trigger.types.length === 0 || one.trigger.types.includes(event.type)));
    if (starting.length > 0) {
      const row = await bookings.row(booking);
      for (const workflow of starting) {
        const id = `bk-${shortHash(`${workflow.id}:${event.id}`)}`;
        try {
          await engine.create(workflow, { id, row, rowKey: booking.id, start: { kind: "booking", bookingEvent: event.id } });
          await engine.advance(id);
        } catch (error) {
          if (!(error instanceof CaseBusy) && !(error instanceof RevisionConflict)) throw error;
        }
      }
    }

    /* Last, so an event handed over again is not counted twice. */
    const previous = typeof event.payload["previous"] === "string" ? event.payload["previous"] : undefined;
    const by = event.payload["by"] as { kind?: string } | undefined;
    if (event.kind === "confirmed" && previous !== "confirmed") {
      await contacts.bump(booking.contact, "bookings", event.at).catch(() => undefined);
      await contacts.preferredHost(booking.contact, booking.host).catch(() => undefined);
    }
    if (event.kind === "cancelled" && by?.kind === "contact") await contacts.bump(booking.contact, "cancellations", event.at).catch(() => undefined);
    if (event.kind === "no_show") await contacts.bump(booking.contact, "noShows", event.at).catch(() => undefined);
  }
}
