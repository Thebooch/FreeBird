# Writing held-out providers

The benchmark's held-out providers are written by a **separate agent session**, not by whoever builds the integration loop. The loop's author wires them in and runs them at checkpoints. It does not read their patterns: an examiner who is also the author tests only what they thought of.

This file is the brief for that session.

## What to write

A new file, `apps/server/src/bench/providers/heldout-<yyyy-mm-dd>.ts`, with **5–8 mock providers**, registered in `providers/index.ts` with `split: "heldout"`. Each is a small in-process API — documentation, seeded data, answer keys — shaped like a real business SaaS API.

Draw the patterns from real APIs you know. Real APIs are awkward in specific ways, and those are what to reproduce. Examples of the kind of thing, not a list to copy:
- query languages in a parameter;
- `modified_since` headers;
- incremental exports;
- expansions and includes;
- cursors inside nested objects;
- per-tenant hosts;
- rate limits with odd headers;
- dates in three formats;
- money in minor units;
- soft-deleted records that must be excluded;
- totals that disagree with the pages;
- documentation that is wrong or out of date;
- GraphQL connections;
- XML;
- HTML-only documentation.

Aim for a spread:
- **Categories:** accounting, payments, CRM, support, project management, e-commerce, property management — no more than two per category.
- **Kinds of difficulty:** some a careful developer could configure declaratively from the docs, some that need a program (a sign-in flow, several requests per read, an unusual format), and at least one documented only in prose (HTML).
- **At least one GraphQL API.**
- **At least one whose documentation is wrong** in a way a real developer would discover by trying it.

Each provider (`MockProvider` in `bench/types.ts`) needs:
- `pattern`: one line saying what it exercises.
- `docsUrl` and a `handle(request)` that serves the documentation and the API from the provider's own hosts (`*.bench.test`).
- `credentials` and `credentialLabels`: what a person would paste, with the names the provider's settings page uses.
- At least one objective. It needs a plain-language `request`, and an `answer` computed from the seed by reference code in the same file. That means filtering and summing the seed, never calling anything in Dash. It also needs a `tolerance`, the `records` the collection holds, and a `scripted` choice (the endpoint path and the measure a correct integrator would pick).
- Deterministic data: `random(seed)` from `bench/seed.ts`, and `reset()` for any state.
- A `reference` connection where Dash's connection format can express it — a hand-written configuration that reaches the answer, to prove the key. Read `packages/spec/src/connection.ts`, `primitives.ts` and `connector.ts` for the format. Where no configuration can reach the data, leave `reference` out and say so in a comment. Connector code in a reference imports only `connectorHash` from `connector/adapter.ts`.

## What not to read

- `apps/server/src/integrate/` — the loop, its repairs and its model prompts;
- `apps/server/src/discovery/` — the importers;
- the internals of `apps/server/src/connector/` (beyond `connectorHash`);
- `packages/agent/`;
- `bench/results/` — what the loop has passed and failed;
- the existing held-out and dev providers' designs, beyond one file for the format (`providers/heldout-step3.ts`).

## How to check your work

```bash
npx vitest run dash/apps/server/src/bench/bench.test.ts
```

Every provider with a `reference` must pass the answer-key test. Do not run `pnpm bench` with the agent integrator, and never `--live`: running the loop against them is the checkpoint's job, and a run before then spends the held-out set.

## When done

Add a dated entry to `bench/PROTOCOL.md`'s change log listing the provider ids, then report back only:
- the ids;
- that the key test passes;
- which providers have no reference, and why.

Not how the loop might fare.
