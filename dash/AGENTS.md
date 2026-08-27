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

## Gotchas (paid for elsewhere, don't rediscover)

- **Vitest runs serial** (`--fileParallelism=false`). Parallel workers flake on the OneDrive filesystem.
- **`zod-to-json-schema` chokes on refinements, records, and unions.** The tool schema handed to the LLM must be flat; the real zod schema validates *after* mapping.
- **The Anthropic adapter defaults `maxOutputTokens` to 1024.** Set it explicitly.
- **Vite proxy keys are plain prefixes.** Use a regex key (`"^/api/"`) or it swallows app routes.
- **React controlled inputs ignore direct `.value` writes.** When driving them programmatically in browser verification, use the native value setter plus an `input` event.
