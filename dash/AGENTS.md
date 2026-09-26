# FreeBird Dash — working notes

## Layout

```
packages/
  spec/        @freebirdai/dash-spec        zod schemas + JSON Schema export
  expr/        @freebirdai/dash-expr        safe path + expression engine  ← security core
  runtime/     @freebirdai/dash-runtime     isomorphic pipeline executor
  adapters/    @freebirdai/dash-adapters    SourceAdapter iface + inline/rest/mcp
  components/  @freebirdai/dash-components  React components with role contracts
  react/       @freebirdai/dash-react       provider, hooks, grid, widget shell
  agent/       @freebirdai/dash-agent       schema inference + LLM binding proposal
apps/
  server/      Fastify :4600     vault, SSRF-guarded query proxy, spec files
  web/         Vite React :5400  the dashboard product
```

## Conventions

Mirrors the FreeBird monorepo: `"type": "module"`, tsup ESM builds, zod ^3 as a peer, vitest, per-package `tsc --noEmit`, `workspace:*` internal deps. Packages should be foldable into the OSS FreeBird monorepo later without rework.

The `LlmAdapter` / `LlmTool` / `LlmStreamChunk` interfaces in `@freebirdai/dash-agent` are copied byte-for-byte from `@freebirdai/core`'s `adapters/llm.ts` so `@freebirdai/adapters-llm-openai` and `-anthropic` drop in unchanged once published. **Do not drift them.**

## Hard rules

- **No `eval`, no `new Function`, no third-party JSONPath library.** Grafana's JSON API plugin shipped an XSS because `jsonpath-plus` allows embedded subexpressions implemented as arbitrary JavaScript. `@freebirdai/dash-expr` is hand-rolled and parses to an AST.
- **The LLM never runs at render time.** It proposes a spec; deterministic code executes it.
- **Pagination is declared, never inferred.** A wrong guess doesn't error — it silently returns the first page and a chart that's quietly incomplete.
- **API responses are untrusted input to the LLM.** Truncate, redact, and carry an explicit untrusted-data clause in the system prompt.
- **`runPipeline` takes an injected clock.** No `Date.now()` in the runtime — determinism and testability.

## Writes (changes to connected accounts)

- **`ops` stay GET-only.** `opDefSchema.method` is a literal. Endpoints that change things live in `CatalogEntry.writes` — never in `ops` — so no widget, keeper target, `/api/query`, brief or resource derivation can name one. Only `WriteService` (`apps/server/src/writes/service.ts`) sends a write.
- **Every write is reviewed, then committed.** `prepare` reads the record fresh (never from the cache), builds the exact request and a before/after review, and returns a digest; `commit` sends only a review whose digest matches, once, for the person who prepared it, after re-reading the record and refusing if it moved (409 with a fresh review).
- **A replace (`PUT`) is built from the record, never from the changes alone.** Each request field's `readFrom` says where its current value is shown; fields that cannot be read are listed on the review as "not sent". Settle them with "Match fields" (the `writes` model task) or a person's mapping — never by string similarity at run time.
- **No retries and no redirect-following on writes.** A timeout after sending is reported as "unknown outcome", never as "nothing changed".
- **Chat never prepares at confirm.** The guide harness re-runs `preflight` at the moment somebody clicks Apply and merges its `resolvedArgs`; `change_record`/`remove_record` therefore reuse the review while proposing and only *check* it at confirm (`ctx.auth.extra.via === "confirm"`).
- **Every attempt is journalled and policy-checked.** `WriteJournal` gets a full event (before, sent, after, changed, reversal hint) for successes, failures, refusals and unknown outcomes; `Policy.can` is asked on prepare and again on commit. OSS defaults: `localOwner()`, `ownerPolicy`, `nullJournal` — see `apps/server/src/identity/README.md`.
- **Writes are native to every connection — there is nothing to switch on.** The review is the safety step, and `Policy.can` is the only gate (always yes in OSS). An endpoint read from prose (`confidence: "inferred"`) is offered too and says so on its review; `confirmed: false` (set by `PUT …/writes/:opId/offered`) is the one way to stop offering an endpoint.
- **The browser never holds a catalog entry's `writes`** (`catalogForBrowser`); a save from the browser keeps the server's. An entry whose writes were never read (`writesVersion` absent, `origin: "openapi"`) has them read from its published specification — a docs read, never the account — when a connection is added from it and once per run at startup (`WriteEndpointReader`, `autoReadWrites`, on only in `index.ts`). `IMPORT_VERSION` is deliberately not bumped for writes.
- **Every row that is a record can be changed where it is shown.** Components draw `RowActions` from the optional `rowActions` render prop; the host builds them with `recordChangeRequests` + `changeRowActions` from `recordTargetFor` and the server's `allowed` view, so a row's menu and its click always agree on the record.

## Gotchas (paid for elsewhere, don't rediscover)

- **Vitest runs serial** (`--fileParallelism=false`). Parallel workers flake on the OneDrive filesystem.
- **`zod-to-json-schema` chokes on refinements, records, and unions.** The tool schema handed to the LLM must be flat; the real zod schema validates *after* mapping.
- **The Anthropic adapter defaults `maxOutputTokens` to 1024.** Set it explicitly.
- **Vite proxy keys are plain prefixes.** Use a regex key (`"^/api/"`) or it swallows app routes.
- **Escapes in a Python-heredoc edit script are read twice.** Writing `.join("\n\n")` from inside a `python - <<'EOF'` block lands a literal newline in the file, not the two characters. `HEAD` carried a broken `server.ts` for exactly this reason — a mangled `join` that made the whole file unparseable, so `apps/server` did not typecheck. Build such strings with `chr(92)` rather than trusting the escape, and check the exit code: a loop ending in `; echo ok` reports success it did not verify.
- **React controlled inputs ignore direct `.value` writes.** When driving them programmatically in browser verification, use the native value setter plus an `input` event.
