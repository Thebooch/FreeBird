# @freebirdai/adapters-db-prisma

Prisma adapter for FreeBird. Copy the models from
`node_modules/@freebirdai/adapters-db-prisma/prisma/schema.prisma` into your
own `schema.prisma`, run `prisma migrate dev`, and plug your `PrismaClient`
in:

```ts
import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@freebirdai/adapters-db-prisma";

const prisma = new PrismaClient();
const db = createPrismaAdapter({ prisma });
```

> **Note on digest scanning**
>
> `listDueDigests` filters in-memory because Prisma's JSON support varies
> across databases. If you run many thousands of saved tabs,
> prefer `@freebirdai/adapters-db-postgres`, which filters via
> `digest->>'nextRunAt'` on the database side.
