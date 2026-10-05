import type { AcceptedShape, Drift } from "./detect.js";

/**
 * The shape each endpoint was accepted in, and any change seen since.
 *
 * Names and kinds only, per connection and endpoint: what a later answer is
 * held against. A plug-in point: memory in tests, Dash's database in the
 * open-source build, wherever a hosted build keeps everything else. Forgotten
 * with the connection.
 */

export interface OpenDrift {
  readonly op: string;
  /** When it was first seen. */
  readonly since: string;
  readonly drift: Drift;
  /** The shape it drifted from, for the words that say so. */
  readonly accepted: AcceptedShape;
}

export interface ShapeStore {
  /** The shape an endpoint was accepted in, or null when none has been kept. */
  accepted(connection: string, op: string): Promise<AcceptedShape | null>;
  /** Accept a shape, closing any drift open against the one before it. */
  accept(connection: string, op: string, shape: AcceptedShape): Promise<void>;
  /** The changes still open on a connection. */
  open(connection: string): Promise<readonly OpenDrift[]>;
  /** A change seen: kept with the time it was first seen. */
  report(connection: string, op: string, drift: Drift, at: string): Promise<void>;
  /** The answer is back in its accepted shape. */
  close(connection: string, op: string): Promise<void>;
  forget(connection: string): Promise<void>;
}

interface Row {
  accepted: AcceptedShape;
  drift: Drift | null;
  since: string | null;
}

export class MemoryShapeStore implements ShapeStore {
  private readonly rows = new Map<string, Map<string, Row>>();

  private of(connection: string): Map<string, Row> {
    const ops = this.rows.get(connection) ?? new Map<string, Row>();
    this.rows.set(connection, ops);
    return ops;
  }

  async accepted(connection: string, op: string): Promise<AcceptedShape | null> {
    return this.rows.get(connection)?.get(op)?.accepted ?? null;
  }

  async accept(connection: string, op: string, shape: AcceptedShape): Promise<void> {
    this.of(connection).set(op, { accepted: shape, drift: null, since: null });
  }

  async open(connection: string): Promise<readonly OpenDrift[]> {
    return [...(this.rows.get(connection) ?? [])].flatMap(([op, row]) =>
      row.drift && row.since ? [{ op, since: row.since, drift: row.drift, accepted: row.accepted }] : [],
    );
  }

  async report(connection: string, op: string, drift: Drift, at: string): Promise<void> {
    const row = this.rows.get(connection)?.get(op);
    if (row) this.of(connection).set(op, { ...row, drift, since: row.since ?? at });
  }

  async close(connection: string, op: string): Promise<void> {
    const row = this.rows.get(connection)?.get(op);
    if (row) this.of(connection).set(op, { ...row, drift: null, since: null });
  }

  async forget(connection: string): Promise<void> {
    this.rows.delete(connection);
  }
}
