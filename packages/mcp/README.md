# @freebirdai/mcp

Opt-in [Model Context Protocol](https://modelcontextprotocol.io) server for
FreeBird hosts. Exposes registered components and actions to external agents
(Cursor, Claude Desktop, custom bots) with host-controlled access modes and
FreeBird-owned schema guidance.

## Activation

The MCP surface **does not exist** unless you construct it:

```ts
import { createFreeBirdMcpServer } from "@freebirdai/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registry } from "./freebird.server.js";

const mcp = createFreeBirdMcpServer({
  registry,
  mode: "read-write", // required — no implicit write access
  getAuthContext: () => ({ userId: "u1", orgId: "org1" }),
  onActionEvent: (event, auth) => {
    if (event.source === "mcp") myAudit.log(event, auth);
  },
  executeReviewItems: async (input, ctx) => ({
    items: await loadReviewItems(input.componentId, ctx.auth),
  }),
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
```

Return `null` from `getAuthContext` to deny MCP access for a tenant or user.

## Access modes

| Mode | Metadata tools | Data reads | Writes |
|------|----------------|------------|--------|
| `read-only` | yes | yes | no |
| `read-write` | yes | yes | yes |
| `write-only` | yes | no | yes |

Per-action / per-component overrides on the registry:

```ts
registry.register({
  id: "billing",
  title: "Billing",
  description: "…",
  grid: { minW: 4, minH: 3 },
  mcp: { read: false }, // hide dataSource reads
  actions: [
    {
      id: "refund",
      description: "Issue a refund",
      schema: z.object({ orderId: z.string(), amount: z.number() }),
      mcp: { expose: false }, // hidden from MCP entirely
      authorize: async (args, ctx) => ctx.auth.role === "admin",
      handler: async (args) => refund(args),
    },
  ],
});
```

## Tools

| Tool | Purpose |
|------|---------|
| `freebird_list_actions` | Catalog exposed actions + readable/reviewable components |
| `freebird_describe_action` | Full JSON Schema + required fields for one action |
| `freebird_read_component` | Run `dataSource()` for MCP-readable components |
| `freebird_review_items` | Load reviewable items (requires `executeReviewItems`) |
| `freebird_prepare_action` | Validate partial args; returns `missing[]` and optional `confirmationToken` |
| `freebird_execute_action` | Run the action through the same pipeline as HTTP confirm |

### Schema guidance (FreeBird-owned)

Hosts define Zod schemas once on `ActionDefinition.schema`. MCP reuses
`validateActionArgs` — the same helper the chat harness uses — so agents
get identical `missing[]` / error reporting:

```json
{
  "ready": false,
  "missing": ["channelId", "topic"],
  "normalizedArgs": { "theme": "dark" }
}
```

No host-side “what’s still needed” logic is required.

### Confirmation for headless agents

| `requiresConfirmation` | MCP flow |
|------------------------|----------|
| `"none"` | `freebird_execute_action` runs when args validate |
| `"preview"` / `"strict"` | `freebird_prepare_action` → `confirmationToken` → `freebird_execute_action` |

Override with `action.mcp.requireConfirmation: true` to force the token flow
even for `"none"` actions.

## Security

- **`authorize` is the boundary.** MCP calls `runAction()` in `@freebirdai/core`,
  which runs `authorize` before `handler` — same as `POST /actions/confirm`.
- **`setActiveComponentIds` does not gate MCP.** It only limits what the
  in-app chat LLM can start. Lock down sensitive actions with `authorize`,
  `mcp.expose: false`, or by not enabling the MCP server.
- Audit events include `source: "mcp"` on `onActionEvent` for throttling and
  logging.

## Cursor / Claude Desktop config (stdio)

```json
{
  "mcpServers": {
    "my-app-freebird": {
      "command": "node",
      "args": ["./dist/mcp-entry.js"],
      "env": {
        "FREEBIRD_MCP_MODE": "read-write"
      }
    }
  }
}
```

Your entry script should construct the registry, resolve auth from env/session,
and call `createFreeBirdMcpServer` + `StdioServerTransport`.

## Package exports

- `createFreeBirdMcpServer(options)` — main factory
- `runAction` / `prepareActionArgs` — re-exported from `@freebirdai/core` via shared pipeline
- Access helpers: `listExposedActions`, `isActionExposed`, `resolveToolAccess`, …
