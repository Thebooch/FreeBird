# @freebirdai/vue-tailwind

Opinionated, pre-styled Vue 3 components for FreeBird. Built on top of the
headless primitives in [`@freebirdai/vue`](../vue). Everything is themed with
CSS variables so you can drop it in unchanged or override a handful of
variables to match your app.

## Install

```bash
pnpm add @freebirdai/vue @freebirdai/vue-tailwind
# tailwind is optional but recommended for matching utility classes around
# the preset
pnpm add -D tailwindcss
```

## Usage

```ts
// main.ts
import { createApp } from "vue";
import App from "./App.vue";
import {
  FreeBirdPlugin,
  createFetchTransport,
  ComponentRegistry,
} from "@freebirdai/vue";
import "@freebirdai/vue-tailwind/styles.css";

const registry = new ComponentRegistry();
// registry.register({ ... });

createApp(App)
  .use(FreeBirdPlugin, {
    transport: createFetchTransport({ baseUrl: "/api/freebird" }),
    registry,
  })
  .mount("#app");
```

```vue
<!-- App.vue -->
<script setup lang="ts">
import {
  ChatPanel,
  DynamicGrid,
  CustomTabBar,
} from "@freebirdai/vue-tailwind";
</script>

<template>
  <div style="display: grid; grid-template-columns: 1fr 360px; gap: 16px;">
    <div>
      <CustomTabBar />
      <DynamicGrid />
    </div>
    <ChatPanel />
  </div>
</template>
```

## Theming via CSS variables

Override the defaults in your own `:root` rule:

```css
:root {
  --freebird-accent: #f97316;
  --freebird-radius: 1rem;
  --freebird-surface: #0b1220;
  --freebird-text: #e6edf3;
}
```

See `src/styles.css` for the full list.

## Optional: Tailwind plugin

If you use Tailwind, the package ships a plugin that registers the same
color tokens as Tailwind utilities (e.g. `bg-freebird-accent`):

```js
// tailwind.config.js
import freebirdPlugin from "@freebirdai/vue-tailwind/plugin";
export default {
  content: ["./index.html", "./src/**/*.{vue,ts,tsx}"],
  plugins: [freebirdPlugin],
};
```

## What you get

| Component | Mirrors headless |
|---|---|
| `ChatPanel` | `ChatPanelRoot/Messages/Form/Input/Submit/Message` |
| `DynamicGrid` | `DynamicGrid` (with built-in `LockToggle` + `InfoTrigger` overlays on each cell) |
| `LockToggle` | `LockToggle` (pre-iconed 🔒 / 🔓) |
| `InfoTrigger` | `InfoTrigger` (pre-iconed "i") |
| `CustomTabBar` | `CustomTabBarRoot/List/Item/Save` |

Need something more custom? Drop back to the headless components in
`@freebirdai/vue` — they emit the exact same `data-freebird-*` attributes,
so the CSS in this package applies to them as well.
