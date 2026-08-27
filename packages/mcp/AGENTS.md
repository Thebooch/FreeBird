# @freebirdai/mcp — AI integration guide

Instructions for an AI assistant exposing a FreeBird host's components and actions to external agents over the Model Context Protocol.

## What this is

An opt-in MCP server over an existing FreeBird registry. External agents (Claude Desktop, Cursor, custom bots) get catalog/read/prepare/execute tools that run through the exact same validation + `authorize` + audit pipeline as the in-app chat and HTTP confirm.

Use only when the host explicitly wants external-agent access. The MCP surface does not exist unless constructed.

## Install

```bash
pnpm add @freebirdai/mcp @modelcontextprotocol/sdk
```

## Minimal integration

Create an entry script (e.g. `mcp-entry.ts`) next to your existing server-side registry:

```ts
import { createFreeBirdMcpServer } from "@freebirdai/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registry } from "./freebird.server.js";   // the SAME registry your app serves

const mcp = createFreeBirdMcpServer({
  registry,
  mode: "read-write",              // REQUIRED: "read-only" | "read-write" | "write-only"
  getAuthContext: () => resolveAuthFromEnvOrSession(),   // return null to deny access
  onActionEvent: (event, auth) => {
    if (event.source === "mcp") audit.log(event, auth);
  },
});

await mcp.connect(new StdioServerTransport());
```

Register it with the agent host (Claude Desktop / Cursor config):

```json
{
  "mcpServers": {
    "my-app-freebird": { "command": "node", "args": ["./dist/mcp-entry.js"] }
  }
}
```

## Key APIs

- `createFreeBirdMcpServer({ registry, mode, getAuthContext, onActionEvent?, executeReviewItems? })`
- Tools exposed: `freebird_list_actions`, `freebird_describe_action`, `freebird_read_component`, `freebird_review_items`, `freebird_prepare_action`, `freebird_execute_action`
- Access modes: `read-only` (no writes), `read-write`, `write-only` (no dataSource reads)
- Per-item overrides on the registry: `component.mcp.read: false` (hide reads), `action.mcp.expose: false` (hide entirely), `action.mcp.requireConfirmation: true` (force the prepare→token→execute flow)
- Confirmation: actions with `requiresConfirmation: "preview" | "strict"` require `freebird_prepare_action` → `confirmationToken` → `freebird_execute_action`

## Works with

- `@freebirdai/core` — the registry and the shared `runAction()` pipeline.
- `@freebirdai/server` — same registry instance can back both HTTP and MCP.

## Common pitfalls (security-critical)

- **`authorize` is the only real boundary.** `setActiveComponentIds` gates the in-app chat harness only — MCP ignores it. Every sensitive action needs `authorize(args, ctx)`, or `mcp.expose: false`.
- **Don't default to `read-write`.** Pick the narrowest mode that works; there is no implicit write access by design.
- **`getAuthContext` returning a static admin identity** hands admin power to any connected agent. Resolve real identity (env-scoped token, session) and return `null` to deny.
- **`freebird_review_items` errors** → requires the `executeReviewItems` option; omit reviewable components from MCP if you don't provide it.

## Verify

Connect with any MCP client and call `freebird_list_actions` — the catalog should show exactly the intended exposure. Then `freebird_prepare_action` with partial args must return `missing[]`, and `freebird_execute_action` on a preview-gated action without a token must be refused.
