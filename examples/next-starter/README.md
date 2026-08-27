# FreeBird — Next.js starter

An end-to-end demo wiring `@freebirdai/core`, `@freebirdai/server`, and the
Tailwind preset inside a Next.js App Router app.

```bash
pnpm install
OPENAI_API_KEY=sk-... pnpm --filter freebird-next-starter dev
```

Visit <http://localhost:3000>. Ask the chat `"Show me revenue and users"`
and FreeBird picks components from the registry and lays them out.

Key files:

- `lib/freebird.server.ts` — server-side registry, memory DB, OpenAI adapter.
- `lib/freebird.client.tsx` — mirrored registry with React `render` functions.
- `app/freebird/[...route]/route.ts` — mounts the FreeBird API surface.
- `components/AppShell.tsx` — provider, chat panel, dynamic grid.
