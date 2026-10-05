/**
 * `tsx src/bench/probe-dev-discover.mts <provider id>` — what discovery makes of a
 * dev or real provider, through the bench's own transport. For diagnosing by hand;
 * spends model calls. Never for held-out providers.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analysePage, endpointsNamed } from "@freebirdai/connect/discovery/docs";
import { AUTO_INDEX_PAGES, discover } from "@freebirdai/connect/discovery/index";
import { loadEnvFile } from "../env.js";
import { defaultModelId, llmForModel } from "../llm.js";
import { PROVIDERS } from "./providers/index.js";
import { benchTransport } from "./transport.js";

loadEnvFile({ startDir: dirname(fileURLToPath(import.meta.url)) });
const provider = PROVIDERS.find((one) => one.id === process.argv[2]);
if (!provider || provider.split === "heldout") throw new Error("a dev or real provider id");
const id = defaultModelId(null);
const llm = id ? llmForModel(id, "discover") : null;
const transport = benchTransport([provider]);
const page = await transport.fetchDocument(provider.docsUrl);
console.log("named:", endpointsNamed(analysePage(page.text)).slice(0, 40).join("  "));
const found = await discover(provider.docsUrl, { fetchDocument: transport.fetchDocument, llm, search: null, readIndexUpTo: AUTO_INDEX_PAGES });
console.log("note:", found.note);
for (const warning of found.warnings) console.log("warning:", warning.slice(0, 300));
if (found.entry) console.log("ops:", found.entry.ops.map((op) => `${op.method ?? "GET"} ${op.path}`).join("  "));
