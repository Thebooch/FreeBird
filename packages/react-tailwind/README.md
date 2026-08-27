# @freebirdai/react-tailwind

Opt-in pre-styled layer on top of [`@freebirdai/react`](../react). Ship a polished chat + grid UI in one import without giving up the ability to swap in your own styling later.

## Install

```bash
pnpm add @freebirdai/react-tailwind
```

## Setup

1. Import the styles once in your app root:

```ts
import "@freebirdai/react-tailwind/styles.css";
```

2. (Optional) add the Tailwind plugin for matching utilities:

```ts
// tailwind.config.ts
import freebirdPlugin from "@freebirdai/react-tailwind/plugin";
export default { plugins: [freebirdPlugin] };
```

3. Use the styled components:

```tsx
import { ChatPanel, DynamicGrid, CustomTabBar } from "@freebirdai/react-tailwind";

<CustomTabBar />
<DynamicGrid />
<ChatPanel placeholder="Ask anything…" />
```

## Theming

Everything is driven by CSS variables:

```css
:root {
  --freebird-accent: #f97316;
  --freebird-radius: 1rem;
}

/* Dark mode — just toggle data-theme="dark" on <html> */
```

You can still drop down to the headless primitives from `@freebirdai/react` whenever the defaults aren't what you want.
