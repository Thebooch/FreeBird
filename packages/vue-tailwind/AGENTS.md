# @freebirdai/vue-tailwind — AI integration guide

Instructions for an AI assistant adding FreeBird's pre-styled Vue UI.

## What this is

Opinionated, pre-styled Vue 3 components over the headless primitives in `@freebirdai/vue`, themed entirely with CSS variables. Drop in unchanged, or override a handful of variables to match the app.

## Install

```bash
pnpm add @freebirdai/vue-tailwind @freebirdai/vue @freebirdai/core
```

## Minimal integration

1. Import the stylesheet once and install the plugin (registry setup as in `@freebirdai/vue`'s AGENTS.md):

```ts
// main.ts
import "@freebirdai/vue-tailwind/styles.css";
import { createApp } from "vue";
import { FreeBirdPlugin } from "@freebirdai/vue";
import App from "./App.vue";

createApp(App).use(FreeBirdPlugin, { registry }).mount("#app");
```

2. (Optional) Tailwind plugin for matching utilities:

```ts
// tailwind.config.ts
import freebirdPlugin from "@freebirdai/vue-tailwind/plugin";
export default { plugins: [freebirdPlugin] };
```

3. Use the styled components:

```vue
<script setup lang="ts">
import { ChatPanel, DynamicGrid, CustomTabBar } from "@freebirdai/vue-tailwind";
</script>

<template>
  <CustomTabBar />
  <DynamicGrid />
  <ChatPanel placeholder="Ask anything…" />
</template>
```

## Theming

```css
:root {
  --freebird-accent: #f97316;
  --freebird-radius: 1rem;
}
/* Dark mode: toggle data-theme="dark" on <html> */
```

## Works with

- `@freebirdai/vue` — plugin, composables, and headless fallbacks; mix styled and headless freely.
- `@freebirdai/server` — the server mount.

## Common pitfalls

- **Unstyled output** → the `styles.css` import is missing.
- **Tailwind purge removed classes** → the plugin isn't in `tailwind.config`.
- **One surface needs custom UI** → compose `@freebirdai/vue`'s headless `ChatPanel.*` for that surface instead of forking the styled component.

## Verify

Render `<ChatPanel />` — fully styled out of the box; change `--freebird-accent` and confirm the accent updates.
