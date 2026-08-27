# @freebirdai/react-tailwind — AI integration guide

Instructions for an AI assistant adding FreeBird's pre-styled React UI.

## What this is

An opt-in styled layer over `@freebirdai/react`: polished chat panel, grid, and tab bar in one import, themed by CSS variables. Use it to ship fast; drop down to the headless primitives whenever a piece needs custom UI.

## Install

```bash
pnpm add @freebirdai/react-tailwind @freebirdai/react @freebirdai/core
```

## Minimal integration

1. Import the stylesheet once at the app root:

```ts
import "@freebirdai/react-tailwind/styles.css";
```

2. (Optional) add the Tailwind plugin for matching utilities:

```ts
// tailwind.config.ts
import freebirdPlugin from "@freebirdai/react-tailwind/plugin";
export default { plugins: [freebirdPlugin] };
```

3. Use the styled components inside a `FreeBirdProvider` (set up exactly as in `@freebirdai/react`'s AGENTS.md):

```tsx
import { ChatPanel, DynamicGrid, CustomTabBar } from "@freebirdai/react-tailwind";

<CustomTabBar />
<DynamicGrid />
<ChatPanel placeholder="Ask anything…" />
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

- `@freebirdai/react` — provider, hooks, and headless fallbacks all come from there; mix styled and headless freely.
- `@freebirdai/server` — the server mount; nothing here talks to the network directly.

## Common pitfalls

- **Unstyled output** → the `styles.css` import is missing from the app root.
- **Tailwind purging the preset's classes** → the plugin isn't registered in `tailwind.config`.
- **Need a custom message renderer** → don't fork the styled ChatPanel; compose `@freebirdai/react`'s `ChatPanel.*` primitives for that surface only.

## Verify

Render `<ChatPanel />` — it should appear fully styled (rounded, accent-colored submit). Change `--freebird-accent` and confirm the accent updates.
