import type { ConnectionSpec, OpSpec } from "@freebirdai/connect-spec";
import { driftBetween, driftFields, driftNote, shapeOf, type AcceptedShape } from "./detect.js";
import type { ShapeStore } from "./store.js";

/**
 * Holding each fresh answer against the shape its endpoint was accepted in.
 *
 * The keeper reads every endpoint a board uses, on a rhythm; each answer it
 * brings back is looked at here. A change is never repaired into a saved
 * widget: the endpoint is checked again by itself, and until the answer is
 * back in shape or nothing saved reads what changed, every read of that
 * endpoint says what changed and that it may be wrong.
 */

export interface DriftWatchDeps {
  readonly shapes: ShapeStore;
  readonly now: () => number;
  /**
   * Whether anything the host saved reads these fields of this endpoint. A
   * change nothing reads is the new shape, not a warning. Absent means every
   * change is reported: the engine on its own cannot tell what is relied on.
   */
  readonly readsFields?: (connection: string, op: string, fields: readonly string[]) => boolean;
  /** Check these endpoints again, by themselves, first: a change is when what was confirmed may no longer hold. */
  readonly recheck?: (connection: ConnectionSpec, ops: readonly string[]) => void;
  readonly log?: (line: string) => void;
}

export class DriftWatch {
  /** Open changes, in the words a tile says: connection → endpoint → note. Loaded once per connection. */
  private readonly notes = new Map<string, Map<string, string>>();
  /** The accepted shapes already read from the store: every fresh answer asks, and most change nothing. */
  private readonly held = new Map<string, Map<string, AcceptedShape | null>>();

  constructor(private readonly deps: DriftWatchDeps) {}

  private heldFor(connection: string): Map<string, AcceptedShape | null> {
    const ops = this.held.get(connection) ?? new Map<string, AcceptedShape | null>();
    this.held.set(connection, ops);
    return ops;
  }

  private async acceptedFor(connection: string, op: string): Promise<AcceptedShape | null> {
    const ops = this.heldFor(connection);
    if (!ops.has(op)) ops.set(op, await this.deps.shapes.accepted(connection, op));
    return ops.get(op) ?? null;
  }

  private async loaded(connection: ConnectionSpec): Promise<Map<string, string>> {
    const known = this.notes.get(connection.id);
    if (known) return known;
    const notes = new Map<string, string>();
    for (const open of await this.deps.shapes.open(connection.id)) {
      const title = connection.ops.find((one) => one.id === open.op)?.title ?? open.op;
      notes.set(open.op, driftNote(title, open.accepted, open.drift));
    }
    this.notes.set(connection.id, notes);
    return notes;
  }

  /** The shape a check read an endpoint in: what later answers are held against. */
  async accept(connection: ConnectionSpec, op: OpSpec, body: unknown): Promise<void> {
    const shape = shapeOf(body, op.rowsPath, this.deps.now());
    if (shape.rows === 0) return;
    await this.deps.shapes.accept(connection.id, op.id, shape);
    this.heldFor(connection.id).set(op.id, shape);
    (await this.loaded(connection)).delete(op.id);
  }

  /** A fresh answer from an endpoint a board reads. */
  async observe(connection: ConnectionSpec, op: OpSpec, body: unknown): Promise<void> {
    const now = this.deps.now();
    const accepted = await this.acceptedFor(connection.id, op.id);
    if (!accepted) {
      /* Nothing to hold it against yet: this answer is the first shape kept. */
      await this.accept(connection, op, body);
      return;
    }
    const notes = await this.loaded(connection);
    const drift = driftBetween(accepted, body, op.rowsPath, now);
    if (!drift) {
      if (notes.has(op.id)) {
        await this.deps.shapes.close(connection.id, op.id);
        notes.delete(op.id);
        this.deps.log?.(`${connection.id}/${op.id} answers in its accepted shape again`);
      }
      return;
    }
    /* A change nothing saved reads is the new shape, not a warning on tiles that do not use it. */
    if (!drift.moved && !(this.deps.readsFields?.(connection.id, op.id, driftFields(drift)) ?? true)) {
      await this.accept(connection, op, body);
      this.deps.log?.(`${connection.id}/${op.id} changed shape where nothing saved reads: ${driftFields(drift).join(", ")}`);
      return;
    }
    const fresh = !notes.has(op.id);
    await this.deps.shapes.report(connection.id, op.id, drift, new Date(now).toISOString());
    notes.set(op.id, driftNote(op.title, accepted, drift));
    if (fresh) {
      this.deps.log?.(`${connection.id}/${op.id} has changed since it was checked: ${notes.get(op.id)}`);
      this.deps.recheck?.(connection, [op.id]);
    }
  }

  /** What a tile reading this endpoint says, while a change is open on it. */
  async noteFor(connection: ConnectionSpec, op: string): Promise<string | null> {
    return (await this.loaded(connection)).get(op) ?? null;
  }

  /** Every change open on a connection, in words. */
  async open(connection: ConnectionSpec): Promise<ReadonlyArray<{ readonly op: string; readonly title: string; readonly since: string; readonly note: string }>> {
    const notes = await this.loaded(connection);
    return (await this.deps.shapes.open(connection.id)).map((one) => ({
      op: one.op,
      title: connection.ops.find((each) => each.id === one.op)?.title ?? one.op,
      since: one.since,
      note: notes.get(one.op) ?? driftNote(one.op, one.accepted, one.drift),
    }));
  }

  /** A connection was removed: its shapes go with it. */
  async forget(connection: string): Promise<void> {
    this.notes.delete(connection);
    this.held.delete(connection);
    await this.deps.shapes.forget(connection);
  }
}
