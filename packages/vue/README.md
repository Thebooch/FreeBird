# @freebirdai/vue

Vue 3 bindings for [FreeBird](../../README.md). Provides a plugin, composables, and headless components that mirror `@freebirdai/react` one-to-one.

Requires **Vue >= 3.3** as a peer dependency.

## Install

```bash
pnpm add @freebirdai/core @freebirdai/vue vue
```

## Quick start

```ts
// main.ts
import { createApp } from "vue";
import { FreeBirdPlugin } from "@freebirdai/vue";
import { ComponentRegistry } from "@freebirdai/core";
import { h, type VNodeChild } from "vue";
import App from "./App.vue";

const registry = new ComponentRegistry<VNodeChild>();
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

```vue
<!-- App.vue -->
<script setup lang="ts">
import {
  ChatPanel,
  DynamicGrid,
  InfoTrigger,
  LockToggle,
  useChat,
  useLayout,
} from "@freebirdai/vue";

const { messages, streamingText } = useChat();
const { plan } = useLayout();
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

## What's included

- `FreeBirdPlugin` — `app.use(FreeBirdPlugin, { registry, ... })`
- Composables: `useFreeBird`, `useSession`, `useChat`, `useLayout`, `useCustomTabs`, `useActionState`, `useActionEvents`, `useActionJournal`
- Components: `ChatPanel.*`, `DynamicGrid`, `LockToggle`, `InfoTrigger`, `CustomTabBar.*`, `FreeBirdNavLinks`, `ActionPreview`, `ActionJournal`

Every component is 100% headless — it stamps `data-freebird-*` attributes so you can style them with Tailwind, CSS modules, or scoped styles.

## Actions

> **When to read this:** you want the chat to *do* things on the user's
> behalf. For the full how-to read [`/ACTIONS.md`](../../ACTIONS.md);
> this section is the Vue-only cheat sheet.

### Symbols covered

- `useActionState`, `useActionJournal`, `useActionEvents` composables.
- `<FreeBirdActionPreview>` — scoped-slot confirmation UI.
- `<FreeBirdActionJournal>` — scoped-slot paused/completed history.
- Re-exported types: `ActionDefinition`, `ActionState`, `ActionRecord`,
  `PendingAction`, `ConfirmationPolicy`, `PreviewStrategy`, `ActionEvent`.

### Tell FreeBird which components are active

```ts
import { onMounted, onUnmounted } from "vue";
import { useFreeBird } from "@freebirdai/vue";

const fb = useFreeBird();
onMounted(() => fb.setActiveComponentIds(["settings", "profile"]));
onUnmounted(() => fb.setActiveComponentIds([]));
```

### Confirm before applying

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

### Show paused / completed history

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

### Audit / undo

```ts
import { useActionEvents } from "@freebirdai/vue";

useActionEvents((e) => {
  if (e.kind === "action.executed") {
    myUndoToast.show({ before: e.before, changed: e.changed });
  }
});
```

See [`/ACTIONS.md`](../../ACTIONS.md) for the full event list and the
server-side `onActionEvent` hook.

## Architecture

All state logic and SSE streaming lives in [`@freebirdai/core-state`](../core-state). This package is a thin reactive wrapper using Vue `ref` / `computed` / `provide` / `inject`.
