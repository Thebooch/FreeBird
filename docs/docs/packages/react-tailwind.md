---
title: "@freebirdai/react-tailwind"
---

# @freebirdai/react-tailwind

Opt-in preset on top of `@freebirdai/react`. Pre-styled components wired up
with CSS variables for instant adoption — theme by overriding `--freebird-*`
in your own `:root`.

```ts title="tailwind.config.ts"
import freebirdPlugin from "@freebirdai/react-tailwind/plugin";
export default { plugins: [freebirdPlugin] };
```

```css title="global.css"
@import "@freebirdai/react-tailwind/styles.css";
:root { --freebird-accent: #f97316; --freebird-radius: 1rem; }
```

```tsx
import { ChatPanel, DynamicGrid, LockToggle, InfoTrigger, CustomTabBar } from "@freebirdai/react-tailwind";
```

Any of these can be swapped back to headless primitives without changing
behavior — they're the same components.
