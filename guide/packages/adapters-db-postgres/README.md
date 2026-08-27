# @freebirdai/adapters-db-postgres

Postgres adapter for FreeBird, built on [Kysely](https://kysely.dev) and `pg`.

## Install

```bash
pnpm add @freebirdai/adapters-db-postgres
```

## Setup

Apply the schema:

```bash
psql $DATABASE_URL -f node_modules/@freebirdai/adapters-db-postgres/migrations/001_init.sql
```

Use the adapter:

```ts
import { Pool } from "pg";
import { createPostgresAdapter } from "@freebirdai/adapters-db-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createPostgresAdapter({ pool });
```

## Extending the schema

Import the `FreeBirdSchema` type and intersect it with your own Kysely schema:

```ts
import type { FreeBirdSchema } from "@freebirdai/adapters-db-postgres";
interface Database extends FreeBirdSchema {
  my_table: { id: string /* ... */ };
}
```
