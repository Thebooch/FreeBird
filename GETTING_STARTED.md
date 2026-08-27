# Getting started with FreeBird

This guide walks you from zero to a running FreeBird app — AI-driven chat,
dynamic component layouts, per-component locks, saved custom tabs, and
scheduled email digests — in about fifteen minutes.

The happy-path stack below is **Next.js 15 + Tailwind + OpenAI + an
in-memory database**. Everything is pluggable; see [§ 9 Swapping adapters](#9-swapping-adapters-for-production)
for production-grade replacements.

> **TL;DR** If you want to skip the narrative, clone the repo and run
> `pnpm install && OPENAI_API_KEY=sk-... pnpm --filter freebird-next-starter dev`.
> The runnable reference app lives in `examples/next-starter/`.

---

## 1. How FreeBird is organized

FreeBird ships as a handful of small npm packages. You only install the
ones you need.

| Package | What it does | When you need it |
|---|---|---|
| `@freebirdai/core` | Framework-agnostic engine: registry, chat, layout solver, tabs, knowledge graph, digest engine, adapter interfaces. | Always. |
| `@freebirdai/react` | Headless React primitives and hooks. | Any React frontend. |
| `@freebirdai/react-tailwind` | Opt-in pre-styled Tailwind preset built on the headless primitives. | If you want pretty defaults in one line. |
| `@freebirdai/server` | Route handlers + Express/Fastify/Next.js integrations, in-process digest scheduler, rate-limit middleware. | Any Node backend. |
| `@freebirdai/digest-worker` | Standalone cron worker for digests, with a DB-backed lock. | Multi-replica production. |
| `@freebirdai/adapters-llm-openai` / `-anthropic` | LLM providers. | Pick one (or write your own). |
| `@freebirdai/adapters-db-postgres` / `-prisma` | Database adapters. | Production. (Dev uses `createMemoryDb()`.) |
| `@freebirdai/adapters-email-resend` / `-smtp` | Email providers. | Only if you want digests. |

The **big idea** is that FreeBird itself is just glue: you bring a list of
your components (a *registry*) and some adapters (DB, LLM, optional email),
and FreeBird wires them into a chat-driven experience.

---

## 2. Install

```bash
# in your existing app
pnpm add @freebirdai/core @freebirdai/react @freebirdai/react-tailwind \
         @freebirdai/server @freebirdai/adapters-llm-openai
```

You'll also want either `react` 18+ and Next.js 14+/Express 4+, and
`tailwindcss` 3+ if you're using the pre-styled preset.

---

## 3. The mental model: one registry, two sides

A **ComponentRegistry** is the catalog of everything the AI is allowed to
show. Each component has:

```ts
{
  id: "revenueChart",                    // stable, referenced by chat + tabs
  title: "Revenue over time",            // shown to the LLM
  description: "30-day revenue trend.",  // shown to the LLM
  knowledge: [{ text: "Click a bar to drill in." }], // used by InfoTrigger
  tags: ["revenue", "finance"],          // used by cross-chat references
  grid: { minW: 6, minH: 3, maxW: 12, defaultAspect: "wide" }, // solver hints
  propsSchema: z.object({ range: z.enum(["7d","30d","90d"]).optional() }),
  dataSource: async (ctx) => fetchRevenue(ctx), // SERVER ONLY – digest data
  render: (props) => <RevenueChart {...props} />, // CLIENT ONLY – JSX
}
```

Because `dataSource` and `render` touch different environments (Node vs the
browser), you typically keep **two registry files**:

- `lib/freebird.server.ts` — server registry with `dataSource`s. No JSX.
- `lib/freebird.client.tsx` — client registry with `render`s. Same ids,
  same metadata, just a different function for the last field.

Both registries are the same shape, so the LLM tool schema and the layout
solver work identically on either side. Keeping them in sync is just
"register the same id in both files"; you can factor the shared metadata
out into a third file if you want.

---

## 4. Wire the server

`lib/freebird.server.ts`:

```ts
import { createComponentRegistry } from "@freebirdai/core";
import { createMemoryDb } from "@freebirdai/core/testing";
import { createOpenAiAdapter } from "@freebirdai/adapters-llm-openai";
import { z } from "zod";

export const registry = createComponentRegistry();

registry.register({
  id: "revenueChart",
  title: "Revenue over time",
  description: "30-day revenue trend with month-over-month delta.",
  knowledge: [
    { text: "Defaults to a 30 day window, adjustable via props.range." },
    { text: "Click a bar to drill into that day." },
  ],
  tags: ["revenue", "finance", "time-series"],
  grid: { minW: 6, minH: 3, maxW: 12, defaultAspect: "wide" },
  propsSchema: z.object({ range: z.enum(["7d", "30d", "90d"]).optional() }),
  dataSource: async () => ({ total: 124_500, delta: 0.08 }),
});

// ...register as many components as you want.

export const db = createMemoryDb(); // swap for Postgres / Prisma in prod
export const llm = createOpenAiAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: "gpt-4o-mini",
});
```

### Mount the API (Next.js App Router)

`app/freebird/[...route]/route.ts`:

```ts
import { createFreeBirdRouteHandlers } from "@freebirdai/server/next";
import { db, llm, registry } from "@/lib/freebird.server";

const handlers = createFreeBirdRouteHandlers({
  db,
  llm,
  registry,
  // Required in production. FreeBird passes this object to every handler
  // so DB queries get scoped per tenant. Return null to reject.
  getAuthContext: (req) => ({ userId: getCurrentUserId(req) }),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
```

### Or Express

```ts
import express from "express";
import { createFreeBirdRouter } from "@freebirdai/server/express";
import { db, llm, registry } from "./freebird.server";

const app = express();
app.use(express.json());
app.use("/freebird", createFreeBirdRouter({ db, llm, registry }));
app.listen(4000);
```

### Or Fastify

```ts
import Fastify from "fastify";
import { createFreeBirdPlugin } from "@freebirdai/server/fastify";

const fastify = Fastify();
await fastify.register(createFreeBirdPlugin({ db, llm, registry }));
await fastify.listen({ port: 4000 });
```

That's the entire backend. The routes mounted are:

- `POST /freebird/chat` — streaming chat (SSE) with `plan_layout` tool calling
- `POST /freebird/layout/plan` — non-streaming layout generation
- `GET/POST/PATCH/DELETE /freebird/tabs` — saved tabs CRUD
- `POST /freebird/tabs/:id/digest` — configure a tab's digest
- `POST /freebird/knowledge` — runtime knowledge upserts
- `POST /freebird/sessions` — create a chat session

---

## 5. Wire the client

> **Not using React?** The client story is the same shape in every binding:
> Vue 3 (`@freebirdai/vue`), Angular (`@freebirdai/angular`), and — for static
> sites or WordPress — the script-tag widget (`@freebirdai/embed`). See the
> docs site's *Frameworks* section (`docs/docs/frameworks/`) and each
> package's README; the rest of this guide (server wiring, adapters,
> digests, auth) applies unchanged.

`lib/freebird.client.tsx`:

```tsx
"use client";
import { createComponentRegistry } from "@freebirdai/core";
import type { ReactNode } from "react";
import { RevenueChart } from "@/components/RevenueChart";

export const clientRegistry = createComponentRegistry<ReactNode>();

clientRegistry.register({
  id: "revenueChart", // MUST match the server id exactly
  title: "Revenue over time",
  description: "30-day revenue trend with month-over-month delta.",
  tags: ["revenue", "finance", "time-series"],
  grid: { minW: 6, minH: 3, maxW: 12, defaultAspect: "wide" },
  render: (props) => <RevenueChart {...props} />,
});
```

Then wrap your app:

```tsx
// app/page.tsx
"use client";
import { FreeBirdProvider } from "@freebirdai/react";
import { ChatPanel, DynamicGrid, CustomTabBar } from "@freebirdai/react-tailwind";
import { clientRegistry } from "@/lib/freebird.client";

export default function Page() {
  return (
    <FreeBirdProvider
      registry={clientRegistry}
      transportOptions={{ baseUrl: "/freebird" }}
    >
      <div className="grid grid-cols-[320px_1fr] gap-4 p-4">
        <aside>
          <CustomTabBar saveLabel="Save layout" />
          <ChatPanel placeholder="Ask what you want to see…" />
        </aside>
        <main>
          <DynamicGrid showLocks />
        </main>
      </div>
    </FreeBirdProvider>
  );
}
```

### Add Tailwind (if you want the pre-styled preset)

`tailwind.config.ts`:

```ts
import type { Config } from "tailwindcss";
import freebirdPlugin from "@freebirdai/react-tailwind/plugin";

export default {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    // needed if you're using the preset's pre-built components:
    "./node_modules/@freebirdai/react-tailwind/dist/**/*.js",
  ],
  plugins: [freebirdPlugin],
} satisfies Config;
```

`app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
@import "@freebirdai/react-tailwind/styles.css";

/* Theme overrides — optional. */
:root {
  --freebird-accent: #f97316;
  --freebird-radius: 1rem;
}
```

If you'd rather ship your own styles, skip `@freebirdai/react-tailwind` and
import the headless primitives from `@freebirdai/react` directly — every
element exposes stable `data-freebird-*` attributes and is ARIA-correct.

---

## 6. Run it

```bash
OPENAI_API_KEY=sk-... pnpm dev
```

Open the app, type `"show me revenue and users"` in the chat. FreeBird:

1. Sends your message + the `plan_layout` tool schema to the LLM.
2. Streams the assistant's reply back over SSE.
3. Runs the deterministic layout solver over the LLM's intent to produce
   actual grid placements.
4. `<DynamicGrid/>` re-renders with the new cells, calling your
   `render(props)` for each one.

---

## 7. The six hero features, one-liners each

| Feature | How to use it |
|---|---|
| **Chat** | `<ChatPanel/>` inside `<FreeBirdProvider/>`. `ChatPanel.Root` auto-creates a session on mount (via `useSession`), so you can send immediately once the input enables. To manage sessions yourself, use `<ChatPanel.Root sessionAutoCreate={false}>` and `useSession({ autoCreate: false })`. |
| **Dynamic layouts** | `<DynamicGrid/>` — renders whatever the chat last planned. |
| **Per-component lock** | `<DynamicGrid showLocks/>` renders a lock toggle on each cell; locked cells survive future chat turns. |
| **Custom tabs (saved layouts)** | `<CustomTabBar/>` exposes a "Save layout" button; `useCustomTabs()` lets you `.save({ title })`, `.list()`, `.load(id)`. |
| **Digests** | Call `POST /freebird/tabs/:id/digest` with `{ intervalCron, email }`. The in-process scheduler (or the standalone worker) handles the rest. |
| **Info trigger** | `<InfoTrigger componentId="revenueChart" asChild><HelpIcon/></InfoTrigger>`. Clicking it loads that id into the chat and asks the LLM to explain it. |

### Plugging saved tabs into your *existing* navbar

You don't have to use `<CustomTabBar/>`. FreeBird ships a render-prop
helper that integrates with whatever nav you already have:

```tsx
import { FreeBirdNavLinks } from "@freebirdai/react";

<YourNavbar>
  <HomeLink />
  <FreeBirdNavLinks>
    {({ tab, onClick }) => (
      <YourNavLink key={tab.id} to={`/tabs/${tab.slug ?? tab.id}`} onClick={onClick}>
        {tab.title}
      </YourNavLink>
    )}
  </FreeBirdNavLinks>
  <SettingsLink />
</YourNavbar>
```

### Hiding lock chrome on "static" tabs

When you load a saved tab, users usually don't want to see lock icons —
the layout is already frozen. Hide them:

```tsx
<DynamicGrid showLocks={false} />
```

---

## 8. Cross-chat references (the "tag graph")

Every `ChatSession` carries optional `topic` and `tags[]`, and every
component carries `tags[]`. When a new message mentions a known tag or
registered `componentId`, FreeBird:

1. Pulls the top-k prior messages sharing that tag.
2. Injects them into the LLM prompt as context.
3. Asks the assistant to include a `references[]` array in its reply.

Your UI renders those as chips like *"From chat Q3 review · `revenue` tag"*
(the built-in `<ChatPanel.Message/>` already does this; swap it out with
the `renderMessage` prop if you want a custom look).

You don't configure this — it runs automatically as long as your components
have tags and your sessions optionally carry topics/tags. Nothing to wire.

---

## 9. Swapping adapters for production

Out of the box you're using `createMemoryDb()`, which loses everything on
process restart. When you're ready for a real database:

### Postgres (Kysely)

```bash
pnpm add @freebirdai/adapters-db-postgres pg
psql $DATABASE_URL -f node_modules/@freebirdai/adapters-db-postgres/migrations/001_init.sql
```

```ts
import { createPostgresAdapter } from "@freebirdai/adapters-db-postgres";
export const db = createPostgresAdapter({ connectionString: process.env.DATABASE_URL });
```

### Prisma

Copy the four models from
`node_modules/@freebirdai/adapters-db-prisma/prisma/schema.prisma` into your
own `schema.prisma`, run `prisma migrate dev`, then:

```ts
import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@freebirdai/adapters-db-prisma";
const prisma = new PrismaClient();
export const db = createPrismaAdapter({ prisma });
```

### LLM providers

```ts
import { createAnthropicAdapter } from "@freebirdai/adapters-llm-anthropic";
export const llm = createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  defaultModel: "claude-3-5-sonnet-latest",
});
```

### Email (needed for digests)

```ts
// Resend
import { createResendAdapter } from "@freebirdai/adapters-email-resend";
const email = createResendAdapter({ apiKey: process.env.RESEND_API_KEY!, from: "noreply@acme.com" });

// or SMTP via nodemailer
import { createSmtpAdapter } from "@freebirdai/adapters-email-smtp";
const email = createSmtpAdapter({ host: "smtp.example.com", port: 587, auth: {/*...*/}, from: "noreply@acme.com" });
```

### Writing your own adapter

Each adapter is a plain object implementing an interface exported from
`@freebirdai/core`:

- `DbAdapter` — sessions, messages, tabs, locks. Simplest reference:
  `packages/core/src/testing/memoryDb.ts`.
- `LlmAdapter` — `stream(opts)` yielding `{ textDelta }` or `{ toolCall }`.
  Reference: `@freebirdai/adapters-llm-openai`.
- `EmailAdapter` — a single `send({ to, from, subject, html, text })` method.

---

## 10. Digests (in-process vs standalone worker)

A **custom tab** becomes a **digest** when you attach a `DigestConfig`:

```ts
await fetch("/freebird/tabs/tab_abc/digest", {
  method: "POST",
  body: JSON.stringify({
    intervalCron: "0 9 * * MON", // every Monday 9am
    email: "team@acme.com",
    format: "html",
  }),
});
```

At each tick, FreeBird calls every registered component's `dataSource()`,
sends the bundle to the LLM with a summary prompt, and emails the
rendered digest.

**Pick a mode based on how many API replicas you run:**

- **Single replica (dev, small deployments)** — set
  `scheduler: "inProcess"` on your router. The server process runs the
  cron itself.

  ```ts
  createFreeBirdRouter({ db, llm, email, registry, scheduler: "inProcess" });
  ```

- **Multiple replicas (production)** — leave the API default
  (`scheduler: "external"`) and run `@freebirdai/digest-worker` as a
  separate process. It takes a DB-backed lock so running several worker
  replicas is also safe.

  ```ts
  // worker.ts
  import { DigestWorker } from "@freebirdai/digest-worker";
  import { db, llm, email, registry } from "./freebird.server";
  new DigestWorker({ db, llm, email, registry, tickMs: 60_000 }).start();
  ```

  Or use the CLI: `pnpm exec freebird-digest-worker ./worker.js`.

Both modes share the same core engine in `@freebirdai/core/digest/engine`,
so behavior is identical — the only difference is which process runs it.

---

## 11. Auth, rate limiting, and prompt guards

`getAuthContext(req)` is your single auth hook. Every integration accepts
it; the returned `{ userId?, orgId?, ... }` is passed to every DbAdapter
call so tenancy is enforced at the storage boundary.

```ts
createFreeBirdRouter({
  db, llm, registry,
  getAuthContext: async (req) => {
    const session = await yourAuth.validate(req);
    if (!session) return null;           // 401
    return { userId: session.user.id, orgId: session.org.id };
  },
});
```

Rate limiting and prompt-injection guards are plain Express-style
middleware:

```ts
import { rateLimit, promptGuard } from "@freebirdai/server/middleware";
app.use("/freebird", rateLimit({ windowMs: 60_000, max: 30 }));
app.use("/freebird", promptGuard()); // strips known jailbreak patterns
```

---

## 12. Testing FreeBird in your CI

`@freebirdai/core/testing` exports fakes for all three adapter types:

```ts
import { createChatEngine, createComponentRegistry } from "@freebirdai/core";
import { createMemoryDb, createFakeLlm, createFakeEmail } from "@freebirdai/core/testing";

const registry = createComponentRegistry();
registry.register({ /* ... */ });

const engine = createChatEngine({
  db: createMemoryDb(),
  llm: createFakeLlm({ script: [{ text: "ok", toolCalls: [] }] }),
  registry,
  knowledge: /* from registry */,
});
```

No network, no secrets, deterministic. Use `createFakeEmail()` to capture
digest output in tests.

---

## 13. Troubleshooting

**"Component X is registered on the server but doesn't render."**
You forgot to register it on the *client* registry (or its `id` doesn't
match exactly). Server and client registries must agree on every id.

**"The chat opens but `<DynamicGrid/>` stays empty."**
Make sure `<DynamicGrid/>` and `<ChatPanel/>` are inside the *same*
`<FreeBirdProvider/>`, and the provider's `transportOptions.baseUrl`
matches where your server routes are mounted (`/freebird` by default).

**"SSE isn't streaming — I get everything at once (or not at all)."**
Put any proxy between the browser and Node in "streaming" mode. For
Next.js on Vercel, the default config works; for Cloudflare, disable
compression on the `/freebird/chat` route; for nginx, set
`proxy_buffering off` on that path.

**"Digests fire twice."**
You've got more than one API replica and `scheduler: "inProcess"` on
each. Either switch to `"external"` + `@freebirdai/digest-worker`, or run
the scheduler on exactly one replica. The worker's DB-backed lock is the
only safe multi-replica option.

**"Kysely type errors when I extend the Postgres schema."**
Import `FreeBirdSchema` from `@freebirdai/adapters-db-postgres` and
intersect it with your own schema type:
`new Kysely<FreeBirdSchema & MyTables>()`.

---

## 14. Where to go next

- Run and explore `examples/next-starter/` for a live reference.
- Run `examples/vite-express/` if your stack is SPA + separate Node API.
- Run `examples/static-embed/` to see the script-tag widget on plain HTML.
- Read `ACTIONS.md` to let the chat *do* things — Zod-typed actions with
  previews, confirmation, and auditing.
- Read the concept docs under `docs/docs/concepts/` for deeper dives on
  the chat engine, actions, layout solver, knowledge graph, and digests.
- See `CONTRIBUTING.md` if you want to add adapters, integrations, or
  component features back upstream.

Happy building. If something in this guide is wrong or confusing, that's a
bug — please open an issue.
