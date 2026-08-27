---
slug: /
sidebar_position: 1
title: What is FreeBird?
---

# FreeBird

**FreeBird is an open-source framework for putting an AI-driven backbone
behind any website.** Drop in a registry of your components, wire up an
LLM, and your users get:

- an **embedded chat** that can drive the page — the assistant picks which of
  your components to show, in what layout, and how to explain them,
- **per-component locks** so users can freeze a cell while they keep
  exploring around it,
- **custom tabs** — freeze a layout, name it, and mount it wherever your own
  navbar already lives,
- **scheduled digests** — each saved tab can email a summary on a cron
  (handled in-process for small deployments, by a standalone worker at scale),
- a built-in **knowledge / reference graph** so questions in one chat can
  cite components and messages from another.

You bring your components, your database, and your auth. FreeBird brings the
engine.

## The architecture in one picture

```text
   Browser                        Your Node server                Your data
 ┌──────────┐   HTTP / SSE   ┌─────────────────────┐   adapters  ┌─────────┐
 │ @freebird│ ─────────────► │ @freebirdai/server    │ ──────────► │  DB     │
 │ /react   │                │  + @freebirdai/core   │             │  LLM    │
 └──────────┘ ◄───────────── │  (engine + solver)  │ ──────────► │  Email  │
                              └─────────────────────┘             └─────────┘
```

The entire framework is structured so you can use one feature without
adopting the others. Want only the chat? Only the layout solver? Only the
digests? Each is independently useful.
