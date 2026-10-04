import { randomUUID } from "node:crypto";
import { AdapterError, type FetchContext, type FetchResult, type SourceAdapter } from "@freebirdai/dash-adapters";
import { safeByProtocol, type ConnectionSpec, type OpSpec } from "@freebirdai/dash-spec";
import type { ReadEvent, WriteJournal } from "./journal.js";

/**
 * The journal entry for a read that might not be one, or nothing when the
 * read is safe by protocol — a GET, or a GraphQL query.
 *
 * Decided by the endpoint's `readSafety`, not its method: an endpoint a
 * connector serves is a GET as documented, and may still start an export or a
 * search with POST to be read — which is why it carries an intent basis.
 */
export const readEventFor = (
  connection: ConnectionSpec,
  op: OpSpec,
  via: ReadEvent["via"],
  outcome: { status: ReadEvent["status"]; upstreamStatus?: number; pages?: number },
  now: number,
): ReadEvent | null =>
  safeByProtocol(op.readSafety)
    ? null
    : {
        id: randomUUID(),
        at: new Date(now).toISOString(),
        connection: connection.id,
        opId: op.id,
        method: "POST",
        path: op.path,
        basis: op.readSafety?.basis ?? "unknown",
        via,
        status: outcome.status,
        ...(outcome.upstreamStatus !== undefined ? { upstreamStatus: outcome.upstreamStatus } : {}),
        ...(outcome.pages !== undefined ? { pages: outcome.pages } : {}),
      };

/**
 * A source adapter that journals every read whose safety rests on a reading
 * of the documentation, and passes everything else straight through.
 *
 * Keeping the journal is never allowed to cost the read: what was read is
 * not in doubt, so a journal that refuses is reported and the rows are kept.
 */
export class JournalingAdapter implements SourceAdapter {
  readonly kind: SourceAdapter["kind"];
  readonly transport: SourceAdapter["transport"];

  constructor(
    private readonly inner: SourceAdapter,
    private readonly journal: WriteJournal,
    private readonly warn: (message: string) => void = () => undefined,
  ) {
    this.kind = inner.kind;
    this.transport = inner.transport;
  }

  async fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    if (safeByProtocol(op.readSafety) || !this.journal.recordRead)
      return this.inner.fetch(connection, op, overrides, ctx);
    const keep = (event: ReadEvent | null) => {
      if (!event) return;
      Promise.resolve(this.journal.recordRead?.(event)).catch((error: unknown) =>
        this.warn(`a read of ${connection.id}/${op.id} could not be journalled: ${String(error)}`),
      );
    };
    try {
      const result = await this.inner.fetch(connection, op, overrides, ctx);
      keep(readEventFor(connection, op, "board", { status: "succeeded", upstreamStatus: result.meta.status, pages: result.meta.pages }, ctx.now));
      return result;
    } catch (error) {
      keep(
        readEventFor(
          connection,
          op,
          "board",
          {
            status: "failed",
            ...(error instanceof AdapterError && error.upstreamStatus !== undefined
              ? { upstreamStatus: error.upstreamStatus }
              : {}),
          },
          ctx.now,
        ),
      );
      throw error;
    }
  }
}
