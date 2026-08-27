---
sidebar_position: 2
title: Quickstart
---

# Quickstart (Next.js)

```bash
pnpm add @freebirdai/core @freebirdai/react @freebirdai/react-tailwind \
  @freebirdai/server @freebirdai/adapters-llm-openai
```

### 1. Register your components on the server

```ts title="lib/freebird.server.ts"
import { createComponentRegistry } from "@freebirdai/core";
import { createMemoryDb } from "@freebirdai/core/testing";
import { createOpenAIAdapter } from "@freebirdai/adapters-llm-openai";
import { z } from "zod";

export const registry = createComponentRegistry();

registry.register({
  id: "revenueChart",
  title: "Revenue over time",
  description: "30-day revenue trend with MoM delta.",
  knowledge: ["Defaults to 30 days; click a bar to drill in."],
  tags: ["revenue", "finance"],
  grid: { minW: 6, minH: 3, maxW: 12, defaultAspect: "wide" },
  propsSchema: z.object({ range: z.enum(["7d", "30d", "90d"]).optional() }),
  dataSource: async () => ({ total: 124_500 }),
});

export const db = createMemoryDb();
export const llm = createOpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4o-mini" });
```

### 2. Mount the API surface

```ts title="app/freebird/[...route]/route.ts"
import { createFreeBirdRouteHandlers } from "@freebirdai/server/next";
import { db, llm, registry } from "@/lib/freebird.server";

const handlers = createFreeBirdRouteHandlers({ db, llm, registry });
export const { GET, POST, PATCH, DELETE } = handlers;
```

### 3. Mirror the registry on the client (add `render`s) and wrap your app

```tsx title="app/page.tsx"
"use client";
import { FreeBirdProvider } from "@freebirdai/react";
import { ChatPanel, DynamicGrid, CustomTabBar } from "@freebirdai/react-tailwind";
import { clientRegistry } from "@/lib/freebird.client";

export default function Page() {
  return (
    <FreeBirdProvider registry={clientRegistry} transportOptions={{ baseUrl: "/freebird" }}>
      <CustomTabBar saveLabel="Save layout" />
      <DynamicGrid showLocks />
      <ChatPanel />
    </FreeBirdProvider>
  );
}
```

A runnable version lives in `examples/next-starter/` in the repo.
