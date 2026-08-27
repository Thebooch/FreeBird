---
title: Adapters
---

# Adapters

FreeBird keeps the engine free of vendor lock-in by talking to the outside
world through three simple adapter interfaces.

### DB adapters

- **`@freebirdai/adapters-db-postgres`** — Kysely + `pg`, ships a SQL
  migration.
- **`@freebirdai/adapters-db-prisma`** — drop the provided models into your
  `schema.prisma`.
- In-memory: `createMemoryDb()` from `@freebirdai/core/testing` (dev/tests).

### LLM adapters

- **`@freebirdai/adapters-llm-openai`** — OpenAI Chat Completions, with
  tool-calling and SSE streaming.
- **`@freebirdai/adapters-llm-anthropic`** — Anthropic Messages API.

### Email adapters

- **`@freebirdai/adapters-email-resend`** — Resend HTTP API.
- **`@freebirdai/adapters-email-smtp`** — any SMTP server via `nodemailer`.

### Writing your own

Each adapter is a plain TypeScript object implementing one of three
interfaces exported from `@freebirdai/core`. The in-memory and fake adapters
under `@freebirdai/core/testing` are the simplest references.
