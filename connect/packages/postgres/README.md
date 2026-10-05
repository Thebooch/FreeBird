# @freebirdai/connect-postgres

Postgres stores for `@freebirdai/connect`. Without this package the engine
keeps its evidence, jobs, write journal, accepted shapes, seen values,
credential expiry and leases in memory.

```ts
import { DbEvidenceStore, DbJobStore, DbWriteJournal, openConnectDb } from "@freebirdai/connect-postgres";

const db = await openConnectDb(); // DATABASE_URL, or embedded PGlite under .connect/db
const evidence = new DbEvidenceStore(db);
```

`openConnectDb({ schema })` applies a host's own tables in the same database;
Dash keeps its members, workspaces and snapshots there.
