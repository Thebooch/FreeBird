/**
 * `tsx src/bench/probe-discover.mts <docs url>` — what discovery imports from
 * a documentation page, and what the first check would read. For diagnosing
 * the real split by hand; spends one model call.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTO_INDEX_PAGES,
  connectionFromCatalog,
  discover,
  fetchPublicDocument,
  integrationTargets,
  samplingTargets,
} from "@freebirdai/connect/host";
import { loadEnvFile } from "../env.js";
import { defaultModelId, llmForModel } from "../llm.js";

loadEnvFile({ startDir: dirname(fileURLToPath(import.meta.url)) });
const id = defaultModelId(null);
const llm = id ? llmForModel(id, "discover") : null;
const url = process.argv[2]!;
const found = await discover(url, {
  fetchDocument: async (target) => {
    const answer = await fetchPublicDocument(target);
    return { status: answer.status, text: answer.text, url: answer.url };
  },
  llm,
  search: null,
  readIndexUpTo: AUTO_INDEX_PAGES,
});
console.log(found.note);
if (!found.entry) process.exit(0);
const connection = connectionFromCatalog(found.entry, { id: "probe" });
console.log("base", connection.baseUrl);
console.log("ops", found.entry.ops.map((op) => op.path).join("  "));
console.log("resources", found.entry.resources.map((one) => `${one.id}:${one.listOp ?? "-"}`).join("  "));
const targets = integrationTargets(connection, { canWriteCode: true });
console.log("targets", targets.join(" "));
console.log("sample", samplingTargets(connection, found.entry, targets).join(" "));
