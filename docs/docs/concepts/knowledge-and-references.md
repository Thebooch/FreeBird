---
title: Knowledge & cross-chat references
---

# Knowledge & cross-chat references

### Knowledge items on components

Each `ComponentDefinition` carries a `knowledge` array. Anything you put
here the assistant can use and cite when explaining the component. The
plain-string shorthand is quickest; the object form adds a stable `id`
(required for citability) and metadata:

```ts
knowledge: [
  "Defaults to the last 30 days.",
  { id: "kb_drill", text: "Click a bar to drill into that day.", category: "Tips" },
]
```

### Site-wide knowledge

Beyond per-component facts, the registry holds a site-wide knowledge
collection (`registry.setKnowledge(items)`) — typically compiled from a
[Registration Manifest](../tooling/manifest-and-codegen.md)'s top-level
`knowledge` entries. Items can carry a `source { page, selector, heading }`
so citations deep-link to the exact page section.

### Citations

With `citations: { enabled: true }` on the chat engine, the system prompt
teaches the model to append `[[cite:id]]` markers to statements grounded
in registered knowledge. The engine strips the markers server-side and
resolves them into `ComponentCitation`s on the persisted message —
components first, then knowledge items. `ChatPanel.Citations` (React,
Vue, and Angular) renders them as chips; clicking one navigates to the
source page if needed, scrolls to the anchored element, and highlights it
— the same client-side mechanism as a `local-dom` action, SSR-safe via
`@freebirdai/core`'s `dom/citation-dom` helpers.

### Embeddings retrieval

By default the knowledge-context prompt includes the registry's knowledge
items up to a character budget. Sites with large knowledge bases plug in
their own retrieval via the `knowledgeContext.retrieve` hook:

```ts
createChatEngine({
  // …
  knowledgeContext: {
    retrieve: async ({ text, items, auth }) => {
      // Return the items relevant to this message — e.g. top-k by
      // embedding similarity. Falling back to `items` keeps default behavior.
      return topKByEmbedding(text, items, 12);
    },
  },
});
```

The hook runs per message, receives the full item collection, and returns
the subset to inject — FreeBird stays embeddings-provider-agnostic.

### The info trigger

`<InfoTrigger componentId="revenueChart" />` (or the pre-iconed Tailwind
preset version) attaches an "i" button to any component. Clicking it
dispatches a `freebird:explain` event which `ChatPanel` intercepts —
FreeBird automatically feeds the component id and knowledge items to the
LLM and asks it to explain what it is and how to use it.

Swap the icon to whatever you want:

```tsx
<InfoTrigger componentId="revenueChart">
  <HelpCircleIcon />
</InfoTrigger>
```

### Cross-chat references

Each `ChatSession` carries optional `topic` and `tags[]`. When a new message
mentions a known tag or registered `componentId`, FreeBird pulls the top-k
prior messages sharing that tag and injects them as context. The assistant
reply includes a `references[]` array the UI renders as chips:

> From *Q3 review* · `revenue` tag
