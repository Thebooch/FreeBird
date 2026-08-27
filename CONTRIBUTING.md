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

- `guide/packages/core` — framework-agnostic engine. Pure TypeScript, no DOM deps.
- `guide/packages/core-state` — framework-agnostic client store + HTTP/SSE transport.
- `guide/packages/react`, `guide/packages/vue`, `guide/packages/angular` — headless UI bindings built on `core`/`core-state`.
- `guide/packages/react-tailwind`, `guide/packages/vue-tailwind` — opt-in styled presets.
- `guide/packages/embed` — script-tag chat widget for static sites (Shadow DOM).
- `guide/packages/server` — route handlers + host-framework adapters (Express/Fastify/Next).
- `guide/packages/digest-worker` — optional standalone cron worker.
- `guide/packages/manifest` — Registration Manifest schema + compiler.
- `guide/packages/codegen` — manifest → registry/wiring code generation.
- `guide/packages/create-freebird` — the `create-freebird` / `freebird` CLI.
- `guide/packages/mcp` — MCP server over registered components/actions.
- `guide/packages/adapters-*` — reference adapters for DB/LLM/email. Add new ones here.
- `examples/*` — runnable reference apps (not published).
- `integrations/wordpress` — the WordPress/WooCommerce plugin.
- `docs/` — the Docusaurus documentation site.

## Conventions

- TypeScript, strict mode. Every public API exports its types.
- Framework-agnostic code stays in `core`/`core-state`. Anything framework-specific goes in the matching binding package (`react`, `vue`, `angular`, `embed`).
- Keep layout logic deterministic and unit-tested. LLMs suggest *intent*, not CSS.
- Adapters must implement the interfaces in `guide/packages/core/src/adapters/`.
- Every publishable package change needs a changeset: `pnpm changeset`.

## Adding an adapter

1. Create `guide/packages/adapters-<kind>-<name>` and implement the relevant interface from `@freebirdai/core`.
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
