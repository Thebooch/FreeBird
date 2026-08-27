# FreeBird — Vite + Express example

A minimal split-stack example showing how to wire FreeBird into an existing
Express API and a Vite-powered React SPA.

```bash
pnpm install
OPENAI_API_KEY=sk-... pnpm --filter freebird-vite-express dev
```

The Vite dev server proxies `/freebird/*` to the Express API on port 4000.

Key files:

- `server/index.ts` — mounts `createFreeBirdRouter` on the Express app.
- `src/registry.tsx` — mirrored client registry with React renders.
- `src/App.tsx` — provider, chat panel, dynamic grid.
