# Contributing to FreeBird

Thanks for considering a contribution! FreeBird is an OSS framework and we welcome PRs of all sizes.

## Dev setup

```bash
pnpm install
pnpm build       # build all packages
pnpm typecheck   # typecheck all workspaces
pnpm test        # run the vitest suite
pnpm lint        # eslint over the whole repo
```

The docs site lives in `docs/` (Docusaurus): `pnpm --filter freebird-docs start` for live preview, `pnpm --filter freebird-docs build` to verify it builds.

## Monorepo layout

- `packages/core` — framework-agnostic engine. Pure TypeScript, no DOM deps.
- `packages/core-state` — framework-agnostic client store + HTTP/SSE transport.
- `packages/react`, `packages/vue`, `packages/angular` — headless UI bindings built on `core`/`core-state`.
- `packages/react-tailwind`, `packages/vue-tailwind` — opt-in styled presets.
- `packages/embed` — script-tag chat widget for static sites (Shadow DOM).
- `packages/server` — route handlers + host-framework adapters (Express/Fastify/Next).
- `packages/digest-worker` — optional standalone cron worker.
- `packages/manifest` — Registration Manifest schema + compiler.
- `packages/codegen` — manifest → registry/wiring code generation.
- `packages/create-freebird` — the `create-freebird` / `freebird` CLI.
- `packages/mcp` — MCP server over registered components/actions.
- `packages/adapters-*` — reference adapters for DB/LLM/email. Add new ones here.
- `examples/*` — runnable reference apps (not published).
- `integrations/wordpress` — the WordPress/WooCommerce plugin.
- `docs/` — the Docusaurus documentation site.

## Conventions

- TypeScript, strict mode. Every public API exports its types.
- Framework-agnostic code stays in `core`/`core-state`. Anything framework-specific goes in the matching binding package (`react`, `vue`, `angular`, `embed`).
- Keep layout logic deterministic and unit-tested. LLMs suggest *intent*, not CSS.
- Adapters must implement the interfaces in `packages/core/src/adapters/`.
- Every publishable package change needs a changeset: `pnpm changeset`.

## Adding an adapter

1. Create `packages/adapters-<kind>-<name>` and implement the relevant interface from `@freebirdai/core`.
2. Export a `create<Name>Adapter(options)` factory.
3. Add a README with install + usage.
4. Add a changeset.

## PR checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] Added a changeset if user-facing
- [ ] Updated relevant READMEs / docs

## License

MIT — by contributing you agree your work is licensed under the project's MIT license.
