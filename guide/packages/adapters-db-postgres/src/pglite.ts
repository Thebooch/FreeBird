import {
  CompiledQuery,
  PostgresAdapter as PostgresDialectAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
} from "kysely";
import type { PGlite } from "@electric-sql/pglite";

/**
 * Minimal Kysely dialect for PGlite (embedded WASM Postgres).
 *
 * PGlite speaks Postgres SQL, so the stock Postgres adapter, compiler and
 * introspector work unchanged — only the driver differs: one in-process
 * connection, serialized so transactions cannot interleave.
 *
 * It ships here, on the `./pglite` subpath, so that this adapter can be tested
 * against real Postgres SQL rather than a mock, and so a host app running
 * embedded in development exercises the *same* schema and the *same* queries
 * as its hosted Postgres. `@electric-sql/pglite` is an **optional peer** — the
 * package's main entry never touches it, so nothing is pulled in for anyone
 * who does not import this module.
 *
 * Hand-written rather than taken from `kysely-pglite`, which is broken against
 * current Kysely — do not re-add that package.
 *
 * The caller owns the PGlite client's lifecycle: `kysely.destroy()` does not
 * close it.
 */

class PGliteConnection implements DatabaseConnection {
  constructor(private readonly client: PGlite) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.client.query<R>(compiledQuery.sql, [...compiledQuery.parameters]);
    return {
      rows: result.rows,
      numAffectedRows: BigInt(result.affectedRows ?? 0),
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("PGlite driver does not support streaming queries");
  }
}

class PGliteDriver implements Driver {
  private queueTail: Promise<void> = Promise.resolve();
  private readonly releases = new Map<DatabaseConnection, () => void>();

  constructor(private readonly client: PGlite) {}

  async init(): Promise<void> {}

  /**
   * One connection at a time, handed out in order.
   *
   * PGlite is a single embedded instance; letting two callers interleave
   * statements would let one transaction's `begin` land inside another's.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    const previous = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const connection = new PGliteConnection(this.client);
    this.releases.set(connection, release);
    return connection;
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    this.releases.get(connection)?.();
    this.releases.delete(connection);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async destroy(): Promise<void> {}
}

export class PGliteDialect implements Dialect {
  constructor(private readonly client: PGlite) {}

  createAdapter(): DialectAdapter {
    return new PostgresDialectAdapter();
  }

  createDriver(): Driver {
    return new PGliteDriver(this.client);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}
