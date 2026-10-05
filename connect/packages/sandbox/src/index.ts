import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { ConnectorHook } from "@freebirdai/connect-spec";
import {
  DEFAULT_LIMITS,
  SandboxError,
  type ConnectorSandbox,
  type SandboxHost,
  type SandboxLimits,
  type SandboxSession,
} from "@freebirdai/connect/connector/sandbox";

/**
 * `QuickJsSandbox`: generated connector code, run in QuickJS compiled to
 * WebAssembly, one worker thread per run. Pass it to the engine as its
 * `ConnectorSandbox`; without it the engine refuses connector code.
 */

const prelude = readFileSync(new URL("./prelude.js", import.meta.url), "utf8");
const workerUrl = new URL("./worker.mjs", import.meta.url);

/**
 * The interpreter, compiled once and handed to every worker: compiling it is
 * most of what opening a run costs, and a compiled module holds no state.
 */
type CompiledModule = object;
const wasm = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<CompiledModule> } })
  .WebAssembly;
let compiled: Promise<CompiledModule> | null = null;
const interpreter = (): Promise<CompiledModule> =>
  (compiled ??= wasm.compile(
    readFileSync(createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm")),
  ));

type FromWorker =
  | { t: "ready"; hooks?: ConnectorHook[]; error?: string }
  | { t: "host"; id: number; name: string; args: string }
  | { t: "log"; line: string }
  | { t: "done"; id: number; ok: boolean; value?: string; error?: string; cpuMs: number }
  | { t: "fatal"; message: string };

/**
 * The local sandbox: QuickJS in WebAssembly, one worker thread per run.
 *
 * A fresh interpreter for every run, so nothing one run leaves behind is seen
 * by the next, and the worker is terminated at the end — or at the wall-clock
 * limit, whatever the code is doing then. The worker is given an empty
 * environment: the server's own variables hold its keys.
 */
export class QuickJsSandbox implements ConnectorSandbox {
  constructor(private readonly defaults: SandboxLimits = DEFAULT_LIMITS) {}

  async open(options: {
    readonly code: string;
    readonly module?: string;
    readonly host: SandboxHost;
    readonly limits?: Partial<SandboxLimits>;
    readonly seed?: number;
  }): Promise<SandboxSession> {
    const limits = { ...this.defaults, ...options.limits };
    const host = options.host;
    const wasmModule = await interpreter();
    const worker = new Worker(workerUrl, {
      workerData: {
        wasmModule,
        code: options.code,
        module: options.module ?? null,
        prelude,
        limits,
        now: host.now(),
        seed: options.seed ?? 1,
      },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });

    let closed = false;
    let failure: SandboxError | null = null;
    let nextCall = 1;
    const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let ready: { resolve: (hooks: ConnectorHook[]) => void; reject: (error: Error) => void } | null = null;

    const fail = (error: SandboxError) => {
      if (failure) return;
      failure = error;
      ready?.reject(error);
      for (const pending of calls.values()) pending.reject(error);
      calls.clear();
      closed = true;
      void worker.terminate();
    };

    const timer = setTimeout(
      () => fail(new SandboxError("limit", `The connector took longer than its ${Math.round(limits.wallMs / 1000)} seconds and was stopped.`)),
      limits.wallMs,
    );
    timer.unref?.();

    worker.on("message", (message: FromWorker) => {
      if (closed) return;
      switch (message.t) {
        case "ready":
          if (message.error) ready?.reject(new SandboxError("load", `The connector's code did not load: ${message.error}`));
          else ready?.resolve(message.hooks ?? []);
          ready = null;
          return;
        case "log":
          host.log(message.line);
          return;
        case "host":
          void (async () => {
            let reply: { ok: true; value: string } | { ok: false; error: string };
            try {
              const args = JSON.parse(message.args) as unknown;
              reply = { ok: true, value: JSON.stringify((await host.call(message.name, args)) ?? null) };
            } catch (error) {
              reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
            if (!closed) worker.postMessage({ t: "hostDone", id: message.id, now: host.now(), ...reply });
          })();
          return;
        case "done": {
          const pending = calls.get(message.id);
          calls.delete(message.id);
          if (!pending) return;
          if (message.ok) {
            try {
              pending.resolve(JSON.parse(message.value ?? "null"));
            } catch {
              pending.reject(new SandboxError("run", "The connector answered with something that is not data."));
            }
          } else {
            const limit = /interrupted|out of memory|stack overflow/i.test(message.error ?? "");
            pending.reject(
              new SandboxError(
                limit ? "limit" : "run",
                limit
                  ? `The connector was stopped: ${/memory/i.test(message.error ?? "") ? "it used more memory than it may" : /stack/i.test(message.error ?? "") ? "it recursed too deeply" : "it ran longer than it may"}.`
                  : `The connector failed: ${message.error ?? "no reason given"}`,
              ),
            );
          }
          return;
        }
        case "fatal":
          fail(new SandboxError("run", `The connector's sandbox failed: ${message.message}`));
          return;
      }
    });
    worker.on("error", (error) => fail(new SandboxError("run", `The connector's sandbox failed: ${error.message}`)));
    worker.on("exit", () => {
      if (!closed) fail(new SandboxError("run", "The connector's sandbox stopped."));
    });

    let hooks: ConnectorHook[];
    try {
      hooks = await new Promise<ConnectorHook[]>((resolve, reject) => {
        ready = { resolve, reject };
      });
    } catch (error) {
      clearTimeout(timer);
      closed = true;
      await worker.terminate();
      throw error;
    }

    return {
      hooks,
      call(hook, args) {
        if (failure) return Promise.reject(failure);
        if (closed) return Promise.reject(new SandboxError("run", "This connector run has ended."));
        const id = nextCall++;
        return new Promise((resolve, reject) => {
          calls.set(id, { resolve, reject });
          worker.postMessage({ t: "call", id, hook, args: JSON.stringify(args), now: host.now() });
        });
      },
      async close() {
        clearTimeout(timer);
        if (closed) return;
        closed = true;
        for (const pending of calls.values()) pending.reject(new SandboxError("run", "This connector run has ended."));
        calls.clear();
        await worker.terminate();
      },
    };
  }
}
