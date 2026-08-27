# @freebirdai/vue — AI integration guide

Instructions for an AI assistant adding FreeBird's Vue UI to a host app.

## What this is

Vue 3 bindings mirroring `@freebirdai/react` one-to-one: a plugin, composables, and headless components over `@freebirdai/core-state`. Components are 100% headless and stamp `data-freebird-*` attributes; add `@freebirdai/vue-tailwind` for a pre-styled layer.

Requires **Vue ≥ 3.3**. The server half is `@freebirdai/server` — wire it first.

## Install

```bash
pnpm add @freebirdai/vue @freebirdai/core vue
```

## Minimal integration

1. Register components and install the plugin (ids MUST match the server registry):

```ts
// main.ts
import { createApp, h, type VNodeChild } from "vue";
import { FreeBirdPlugin } from "@freebirdai/vue";
import { createComponentRegistry } from "@freebirdai/core";
import App from "./App.vue";

const registry = createComponentRegistry<VNodeChild>();
registry.register({
  id: "revenueChart",                      // same id as server side
  title: "Revenue chart",
  description: "Monthly revenue for the current year",
  grid: {
    sizes: [
      { name: "compact", w: 4, h: 2, aspect: "wide" },
      { name: "half",    w: 6, h: 3, aspect: "wide" },
      { name: "full",    w: 12, h: 4, aspect: "wide" },
    ],
    preferredSize: "half",
  },
  render: () => h(MyRevenueChart),
});

createApp(App).use(FreeBirdPlugin, { registry }).mount("#app");
// custom API path/auth: pass transport: createFetchTransport({ baseUrl: "/api/freebird", ... })
```

2. Compose the UI:

```vue
<script setup lang="ts">
import { ChatPanel, DynamicGrid } from "@freebirdai/vue";
</script>

<template>
  <ChatPanel.Root>
    <ChatPanel.Messages v-slot="{ messages, streamingText }">
      <ChatPanel.Message v-for="m in messages" :key="m.id" :message="m" />
      <div v-if="streamingText">{{ streamingText }}</div>
    </ChatPanel.Messages>
    <ChatPanel.Form>
      <ChatPanel.Input placeholder="Ask anything..." />
      <ChatPanel.Submit>Send</ChatPanel.Submit>
    </ChatPanel.Form>
  </ChatPanel.Root>
  <DynamicGrid />
</template>
```

3. If using actions — scope per page and add the confirmation UI:

```ts
import { onMounted, onUnmounted } from "vue";
import { useFreeBird } from "@freebirdai/vue";
const fb = useFreeBird();
onMounted(() => fb.setActiveComponentIds(["settings"]));
onUnmounted(() => fb.setActiveComponentIds([]));
```

```vue
<ActionPreview v-slot="{ pending, phase, error, confirm, cancel, pause }">
  <!-- your dialog: confirm() / cancel('user') / pause() -->
</ActionPreview>
```

## Key APIs

- Plugin: `app.use(FreeBirdPlugin, { registry, transport?, ... })`
- Composables: `useFreeBird`, `useSession`, `useChat`, `useLayout`, `useCustomTabs`, `useActionState`, `useActionEvents`, `useActionJournal`
- Components: `ChatPanel.*` (incl. `Citations`), `DynamicGrid`, `LockToggle`, `InfoTrigger`, `CustomTabBar.*`, `FreeBirdNavLinks`, `ActionPreview`, `ActionJournal`
- Re-exported types: `ActionDefinition`, `ActionState`, `ActionRecord`, `PendingAction`, `ActionEvent`

## Works with

- `@freebirdai/server` — transport defaults to `/freebird`.
- `@freebirdai/vue-tailwind` — pre-styled versions of these components.
- `@freebirdai/core-state` — `createFetchTransport` (re-exported from `@freebirdai/vue`) for auth hooks.

## Common pitfalls

- **Client/server id drift** → the two registries must register identical component ids; enforce with `freebird check` or a shared ids module.
- **`useFreeBird()` throws** → the component isn't under an app that installed `FreeBirdPlugin`.
- **Chat resets on route change** → keep the ChatPanel mounted in a layout component above `<RouterView>`.
- **Actions never offered** → `setActiveComponentIds` wasn't called (or an unmount cleared it).
- **Citation chips don't use Vue Router** → pass `onCitationNavigate` on `ChatPanel.Citations`; the default is a full page load.

## Verify

Run the app, send a message, and confirm SSE streams into the panel with no console errors. `examples/vite-express` in the FreeBird repo shows the equivalent wiring (React variant, same transport contract).
