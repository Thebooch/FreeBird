/**
 * The engine behind a small Express app.
 *
 *   pnpm start
 *   curl -X POST localhost:3030/connect/connections -H 'content-type: application/json' \
 *        -d '{"from":"https://api.apis.guru/v2/openapi.yaml"}'
 *   curl -X POST localhost:3030/connect/connections/apis-guru/read -H 'content-type: application/json' \
 *        -d '{"op":"getproviders","fresh":"5m"}'
 *
 * With ANTHROPIC_API_KEY set, `/freebird` also serves a FreeBird chat that
 * reads and changes connected APIs (`@freebirdai/connect-actions`).
 *
 * Changes to a connected account are two requests: `POST .../changes` returns
 * the review, and `POST /connect/changes/:pendingId/commit` with its digest
 * makes the change. `authorize` below decides who may.
 */
import { createAnthropicAdapter } from "@freebirdai/adapters-llm-anthropic";
import { createConnect } from "@freebirdai/connect";
import { createConnectKit } from "@freebirdai/connect-actions";
import { connectRouter } from "@freebirdai/connect-server/express";
import { createComponentRegistry } from "@freebirdai/core";
import { createMemoryDb } from "@freebirdai/core/testing";
import { createFreeBirdRouter } from "@freebirdai/server/express";
import express from "express";

const llm = process.env.ANTHROPIC_API_KEY ? createAnthropicAdapter({ defaultModel: "claude-sonnet-5" }) : null;

const connect = createConnect({
  dir: ".connect",
  llm,
  // Your own permission check. This one lets reads happen and refuses every change.
  authorize: (_actor, permission) => !permission.startsWith("records."),
});
connect.start();
connect.on((event) => console.log(event));

const app = express();
app.use(
  "/connect",
  express.json(),
  connectRouter(connect, {
    // Who is asking, from your own sign-in.
    actor: (request) => ({ userId: String(request.headers["x-user"] ?? "anonymous"), workspaceId: "local" }),
  }),
);

/*
 * A FreeBird chat that can use them: ask "how many properties were built
 * after 2000?", or "rename Maple Court to Maple Court East" and confirm the
 * review. Keys are never typed into the chat; they go through the key route above.
 */
if (llm) {
  const kit = createConnectKit(connect);
  const registry = createComponentRegistry();
  registry.register(kit.component);
  app.use(
    "/freebird",
    express.json(),
    createFreeBirdRouter({
      db: createMemoryDb(),
      llm,
      registry,
      extraTools: kit.tools,
      executeExtraTool: kit.executeTool,
      getAuthContext: (request) => ({ userId: String((request as express.Request).headers["x-user"] ?? "anonymous") }),
    }) as unknown as express.RequestHandler,
  );
}

const port = Number(process.env.PORT ?? 3030);
app.listen(port, () => console.log(`Connect is on http://localhost:${port}/connect`));
