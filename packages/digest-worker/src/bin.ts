/**
 * CLI entry point for the standalone digest worker.
 *
 * Apps customize the worker by writing a thin bootstrap script that:
 *  1. Builds their DB/LLM/Email adapters.
 *  2. Builds the component registry with dataSource() implementations.
 *  3. Constructs a DigestEngine from `@freebirdai/core`.
 *  4. Passes it to `createDigestWorker()` and calls `.start()`.
 *
 * This CLI supports the common case of loading a user module that default-
 * exports a fully-configured worker:
 *
 *   freebird-digest-worker --config ./dist/freebird.config.js
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createDigestWorker, type DigestWorker } from "./index.js";

interface ConfigModuleShape {
  default?: DigestWorker | Promise<DigestWorker>;
  worker?: DigestWorker | Promise<DigestWorker>;
  createWorker?: () => DigestWorker | Promise<DigestWorker>;
}

const parseArgs = (argv: string[]): { config: string; once: boolean } => {
  const out: { config: string; once: boolean } = { config: "", once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a === "-c") out.config = argv[++i]!;
    else if (a === "--once") out.once = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: freebird-digest-worker --config <path-to-config.js> [--once]\n\n" +
          "  The config module must default-export a DigestWorker, export a `worker`,\n" +
          "  or export `createWorker()`.",
      );
      process.exit(0);
    }
  }
  if (!out.config) {
    console.error("freebird-digest-worker: --config is required.");
    process.exit(1);
  }
  return out;
};

const main = async () => {
  const { config, once } = parseArgs(process.argv.slice(2));
  const url = pathToFileURL(path.resolve(process.cwd(), config)).href;
  const mod: ConfigModuleShape = await import(url);
  let worker: DigestWorker;
  if (mod.createWorker) worker = await mod.createWorker();
  else if (mod.worker) worker = await mod.worker;
  else if (mod.default) worker = await (mod.default as Promise<DigestWorker>);
  else {
    console.error("freebird-digest-worker: config module must export a worker.");
    process.exit(1);
  }

  if (once) {
    const results = await worker.runOnce();
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  worker.start();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      console.log(`\n[freebird-digest-worker] received ${sig}, stopping...`);
      await worker.stop();
      process.exit(0);
    });
  }
};

// Keep the worker alive.
main().catch((err) => {
  console.error("[freebird-digest-worker] fatal:", err);
  process.exit(1);
});

// Expose factory to keep import graph clean when used as a library.
export { createDigestWorker };
