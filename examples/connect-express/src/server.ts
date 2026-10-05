/**
 * The engine behind a small Express app.
 *
 *   pnpm start
 *   curl -X POST localhost:3030/connect/connections -H 'content-type: application/json' \
 *        -d '{"from":"https://api.apis.guru/v2/openapi.yaml"}'
 *   curl -X POST localhost:3030/connect/connections/apis-guru/read -H 'content-type: application/json' \
 *        -d '{"op":"getproviders","fresh":"5m"}'
 *
 * Changes to a connected account are two requests: `POST .../changes` returns
 * the review, and `POST /connect/changes/:pendingId/commit` with its digest
 * makes the change. `authorize` below decides who may.
 */
import { createAnthropicAdapter } from "@freebirdai/adapters-llm-anthropic";
import { createConnect } from "@freebirdai/connect";
import { connectRouter } from "@freebirdai/connect-server/express";
import express from "express";

const connect = createConnect({
  dir: ".connect",
  llm: process.env.ANTHROPIC_API_KEY ? createAnthropicAdapter({ defaultModel: "claude-sonnet-5" }) : null,
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

const port = Number(process.env.PORT ?? 3030);
app.listen(port, () => console.log(`Connect is on http://localhost:${port}/connect`));
