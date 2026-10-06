/**
 * Read an API from a plain Node script: no server, no database, no dashboard.
 *
 *   pnpm start                       # APIs.guru, which needs no key
 *   pnpm start <openapi-or-docs-url> # any other API
 *
 * With ANTHROPIC_API_KEY set, the engine also works out what the API's
 * records are, and a read can name a record type instead of an endpoint.
 */
import { createAnthropicAdapter } from "@freebirdai/adapters-llm-anthropic";
import { createConnect } from "@freebirdai/connect";

const from = process.argv[2] ?? "https://api.apis.guru/v2/openapi.yaml";

const connect = createConnect({
  // Keys and worked-out APIs are kept here, encrypted where they are secret.
  dir: ".connect",
  // Only needed to map record types and repair what the docs got wrong; reads never need it.
  llm: process.env.ANTHROPIC_API_KEY ? createAnthropicAdapter({ defaultModel: "claude-sonnet-5" }) : null,
});
connect.on((event) => console.log(`  · ${event.type} ${"op" in event ? event.op : ""}`));

console.log(`Adding ${from}`);
const api = await connect.connections.add({ from });
console.log(`${api.title}: ${api.ops.length} endpoints at ${api.baseUrl}`);

const status = connect.connections.status(api.id);
if (status.needsKey) {
  const key = process.env.API_KEY;
  if (!key) {
    console.log(`${api.title} needs a key. Run again with API_KEY=... set.`);
    process.exit(0);
  }
  await connect.connections.setKey(api.id, key);
}

console.log("Checking it: reading what matters, repairing what the docs got wrong…");
const check = await connect.integrate(api.id);
console.log("error" in check ? `Check could not run: ${check.error}` : `Check: ${check.outcome}, ${check.requests} request(s)`);

const records = connect.records(api.id);
if (records.length > 0) console.log(`Record types: ${records.map((one) => one.name.many).join(", ")}`);

// Read the first endpoint that needs no input. On APIs.guru: every provider it lists.
const op = api.ops.find((one) => !one.path.includes("{{")) ?? api.ops[0]!;
const first = await connect.read(api.id, { op: op.id, fresh: "5m" });
console.log(`${op.title ?? op.id}: ${first.rows.length} row(s), from ${first.cache === "hit" ? "memory" : "the API"}`);
console.log(first.rows.slice(0, 5));

// Asked again within five minutes: answered from memory, the API is not called.
const again = await connect.read(api.id, { op: op.id, fresh: "5m" });
console.log(`Again: ${again.rows.length} row(s), from ${again.cache === "hit" ? "memory" : "the API"}`);

connect.stop();
