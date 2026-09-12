import { mkdirSync } from "node:fs";
import { PostgresAdapter } from "@freebirdai/adapters-db-postgres";
import { PGliteDialect } from "@freebirdai/adapters-db-postgres/pglite";
import { Kysely } from "kysely";
import { IntegrationRepository } from "./repository.js";

export const openIntegrationDb = async (options: { databaseUrl?: string; dataDir?: string; inMemory?: boolean } = {}) => {
  const url = options.databaseUrl ?? (options.inMemory ? undefined : process.env.DATABASE_URL);
  if (url) {
    const adapter = new PostgresAdapter({ connectionString: url });
    const repository = new IntegrationRepository(adapter.db as unknown as Kysely<never>);
    try { await repository.migrate(); }
    catch (error) { await adapter.db.destroy(); throw error; }
    return { repository, close: () => adapter.db.destroy() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = options.inMemory ? "memory://" : options.dataDir ?? ".dash/integration-db";
  if (!options.inMemory) mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = new Kysely<never>({ dialect: new PGliteDialect(client) });
  const repository = new IntegrationRepository(db);
  const close = async () => { await db.destroy(); await client.close(); };
  try { await repository.migrate(); } catch (error) { await close(); throw error; }
  return { repository, close };
};
