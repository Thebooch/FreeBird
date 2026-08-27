import type { ConnectionSpec, OpSpec } from "@freebirdai/dash-spec";
import { getOp } from "@freebirdai/dash-spec";
import { AdapterError, type FetchContext, type FetchResult, type SourceAdapter } from "./types.js";

/**
 * Routes a widget's source to whichever adapter handles that connection kind.
 *
 * Keeping this a lookup rather than a switch is what makes data acquisition
 * genuinely pluggable: the runtime never learns that REST or MCP exist.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly connections = new Map<string, ConnectionSpec>();

  register(adapter: SourceAdapter): this {
    this.adapters.set(adapter.kind, adapter);
    return this;
  }

  addConnection(connection: ConnectionSpec): this {
    this.connections.set(connection.id, connection);
    return this;
  }

  getConnection(id: string): ConnectionSpec | undefined {
    return this.connections.get(id);
  }

  listConnections(): ConnectionSpec[] {
    return [...this.connections.values()];
  }

  adapterFor(kind: string): SourceAdapter | undefined {
    return this.adapters.get(kind);
  }

  resolve(connectionId: string, opId: string): { connection: ConnectionSpec; op: OpSpec; adapter: SourceAdapter } {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new AdapterError(`unknown connection "${connectionId}"`, {
        status: 404,
        userMessage: `This widget points at a connection ("${connectionId}") that no longer exists.`,
      });
    }

    const op = getOp(connection, opId);
    if (!op) {
      throw new AdapterError(`connection "${connectionId}" has no op "${opId}"`, {
        status: 404,
        userMessage: `"${connection.title}" no longer offers "${opId}".`,
      });
    }

    const adapter = this.adapters.get(connection.kind);
    if (!adapter) {
      throw new AdapterError(`no adapter registered for kind "${connection.kind}"`, {
        status: 501,
        userMessage: `Nothing here knows how to talk to a "${connection.kind}" source.`,
      });
    }

    return { connection, op, adapter };
  }

  async fetch(
    connectionId: string,
    opId: string,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    const { connection, op, adapter } = this.resolve(connectionId, opId);
    return adapter.fetch(connection, op, overrides, ctx);
  }
}
