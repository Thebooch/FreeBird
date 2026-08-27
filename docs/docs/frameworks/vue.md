# Vue

`@freebirdai/vue` provides Vue 3 bindings for FreeBird: a plugin, composables, and headless components that mirror `@freebirdai/react` one-to-one. All state logic and SSE streaming live in `@freebirdai/core-state`; this package is a thin reactive wrapper built on `ref` / `computed` / `provide` / `inject`.

Requires **Vue ≥ 3.3**.

## Install

```bash
pnpm add @freebirdai/core @freebirdai/vue vue
```

The server side is identical to every other binding — see [the server package](../packages/server.md) for wiring Express, Fastify, or Next.js.

## Quick start

Register components and install the plugin:

```ts
// main.ts
import { createApp, h, type VNodeChild } from "vue";
import { FreeBirdPlugin } from "@freebirdai/vue";
import { createComponentRegistry } from "@freebirdai/core";
import App from "./App.vue";

const registry = createComponentRegistry<VNodeChild>();
registry.register({
  id: "revenueChart",
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
  render: () => h("div", "Revenue chart"),
});

createApp(App).use(FreeBirdPlugin, { registry }).mount("#app");
```

Compose the UI from headless components:

```vue
<!-- App.vue -->
<script setup lang="ts">
import { ChatPanel, DynamicGrid } from "@freebirdai/vue";
</script>

<template>
  <div>
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
  </div>
</template>
```

Every component is 100% headless — each stamps `data-freebird-*` attributes so you can style with Tailwind, CSS modules, or scoped styles. For a pre-styled starting point, add [`@freebirdai/vue-tailwind`](https://github.com/Thebooch/FreeBird/tree/main/packages/vue-tailwind).

## What's included

- **Plugin** — `app.use(FreeBirdPlugin, { registry, ... })`
- **Composables** — `useFreeBird`, `useSession`, `useChat`, `useLayout`, `useCustomTabs`, `useActionState`, `useActionEvents`, `useActionJournal`
- **Components** — `ChatPanel.*`, `DynamicGrid`, `LockToggle`, `InfoTrigger`, `CustomTabBar.*`, `FreeBirdNavLinks`, `ActionPreview`, `ActionJournal`

## Actions

The full action-layer guide is [Actions](../concepts/actions.md); this is the Vue-specific wiring.

Tell FreeBird which components are on screen so the harness scopes `start_action`:

```ts
import { onMounted, onUnmounted } from "vue";
import { useFreeBird } from "@freebirdai/vue";

const fb = useFreeBird();
onMounted(() => fb.setActiveComponentIds(["settings", "profile"]));
onUnmounted(() => fb.setActiveComponentIds([]));
```

Render the confirmation UI with `ActionPreview` (scoped slot):

```vue
<script setup lang="ts">
import { ActionPreview } from "@freebirdai/vue";
</script>

<template>
  <ActionPreview v-slot="{ pending, phase, error, confirm, cancel, pause }">
    <div role="dialog">
      <h2>{{ pending.label ?? `${pending.componentId}:${pending.actionId}` }}</h2>
      <pre>{{ JSON.stringify(pending.args, null, 2) }}</pre>
      <p v-if="error" role="alert">{{ error }}</p>
      <button :disabled="phase === 'executing'" @click="confirm()">Apply</button>
      <button @click="cancel('user')">Cancel</button>
      <button @click="pause()">Pause</button>
    </div>
  </ActionPreview>
</template>
```

Show paused/completed history with `ActionJournal`:

```vue
<script setup lang="ts">
import { ActionJournal } from "@freebirdai/vue";
</script>

<template>
  <ActionJournal status="paused" v-slot="{ records, resume, discard }">
    <ul>
      <li v-for="r in records" :key="r.id">
        {{ r.label ?? `${r.componentId}:${r.actionId}` }}
        <button @click="resume(r.id)">Resume</button>
        <button @click="discard(r.id)">×</button>
      </li>
    </ul>
  </ActionJournal>
</template>
```

Subscribe to the audit stream:

```ts
import { useActionEvents } from "@freebirdai/vue";

useActionEvents((e) => {
  if (e.kind === "action.executed") {
    myUndoToast.show({ before: e.before, changed: e.changed });
  }
});
```

## Citations

When [citations](../concepts/knowledge-and-references.md) are enabled server-side, assistant replies carry `ComponentCitation`s. `ChatPanel.Citations` renders the chips, and `onCitationNavigate` lets you hand cross-page navigation to Vue Router instead of a full page load.
