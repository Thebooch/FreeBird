/**
 * The sandbox's worker: one QuickJS interpreter, compiled to WebAssembly, in
 * its own thread.
 *
 * Trusted host code — it holds nothing secret and decides nothing. It runs the
 * connector's code inside the interpreter, and passes every request the code
 * makes (a network request, a signature, a pause) to the main thread, which
 * decides whether it is allowed. The interpreter itself has no network, no file
 * system, no clock and no way to reach this thread's own globals: only the two
 * functions installed below.
 *
 * Limits, each enforced here or by the main thread:
 * - memory: the WebAssembly memory has a hard maximum, so an allocation past it
 *   fails inside the code as "out of memory" (QuickJS's own memory limit is not
 *   enforced in this build, so it is not relied on);
 * - CPU: time spent running the code, as opposed to waiting on the main thread,
 *   is counted, and the interpreter is interrupted past the allowance;
 * - wall time: the main thread terminates this worker when a run takes too long,
 *   whatever it is doing.
 *
 * Plain JavaScript rather than TypeScript so it loads as a worker under every
 * way the server runs — tsx, vitest and a built bundle — with no loader.
 */
import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import base from "@jitl/quickjs-wasmfile-release-sync";

const PAGE = 65_536;
const { wasmModule, code, module: endpointCode, prelude, limits, now, seed } = workerData;

let hostNow = now;
let cpuSpent = 0;
let segmentStart = null;
let nextHostId = 1;
/** Host calls waiting on the main thread, by id. */
const waiting = new Map();

const post = (message) => parentPort.postMessage(message);

const maxPages = Math.max(256, Math.floor(limits.memoryBytes / PAGE));
const variant = newVariant(base, {
  wasmModule,
  wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: maxPages }),
});
const module = await newQuickJSWASMModuleFromVariant(variant);
const runtime = module.newRuntime();
runtime.setMaxStackSize(limits.stackBytes);
runtime.setInterruptHandler(
  () => segmentStart !== null && cpuSpent + (performance.now() - segmentStart) > limits.cpuMs,
);
const context = runtime.newContext();

/** Run code in the interpreter, counting the time against the CPU allowance. */
const running = (fn) => {
  segmentStart = performance.now();
  try {
    return fn();
  } finally {
    cpuSpent += performance.now() - segmentStart;
    segmentStart = null;
  }
};

const pump = () => {
  const result = running(() => runtime.executePendingJobs());
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    throw new Error(describe(error));
  }
};

const describe = (error) => {
  if (error && typeof error === "object") {
    const name = typeof error.name === "string" ? error.name : "Error";
    const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
    return `${name}: ${message}`.slice(0, 2_000);
  }
  return String(error).slice(0, 2_000);
};

/* The two ways out: an asynchronous request to the main thread, and a log line. */
const host = context.newFunction("__host", (nameHandle, argsHandle) => {
  const name = context.getString(nameHandle);
  const args = context.getString(argsHandle);
  const deferred = context.newPromise();
  const id = nextHostId++;
  waiting.set(id, deferred);
  post({ t: "host", id, name, args });
  return deferred.handle;
});
context.setProp(context.global, "__host", host);
host.dispose();

const log = context.newFunction("__log", (lineHandle) => {
  post({ t: "log", line: context.getString(lineHandle).slice(0, 500) });
});
context.setProp(context.global, "__log", log);
log.dispose();

const clock = context.newFunction("__now", () => context.newNumber(hostNow));
context.setProp(context.global, "__now", clock);
clock.dispose();

const seedHandle = context.newNumber(seed);
context.setProp(context.global, "__seed", seedHandle);
seedHandle.dispose();

const evaluate = (source, filename) => {
  const result = running(() => context.evalCode(source, filename));
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    throw new Error(describe(error));
  }
  result.value.dispose();
};

/** Call `__invoke(hook, argsJson)` and wait for the promise it returns. */
const invoke = async (hook, argsJson) => {
  const fn = context.getProp(context.global, "__invoke");
  const hookHandle = context.newString(hook);
  const argsHandle = context.newString(argsJson);
  const result = running(() => context.callFunction(fn, context.undefined, hookHandle, argsHandle));
  fn.dispose();
  hookHandle.dispose();
  argsHandle.dispose();
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    throw new Error(describe(error));
  }
  const promise = result.value;
  const settled = context.resolvePromise(promise);
  promise.dispose();
  pump();
  const outcome = await settled;
  if (outcome.error) {
    const error = context.dump(outcome.error);
    outcome.error.dispose();
    throw new Error(describe(error));
  }
  const text = context.getString(outcome.value);
  outcome.value.dispose();
  return text;
};

parentPort.on("message", async (message) => {
  if (message.t === "hostDone") {
    hostNow = message.now;
    const deferred = waiting.get(message.id);
    if (!deferred) return;
    waiting.delete(message.id);
    try {
      if (message.ok) {
        const value = context.newString(message.value);
        deferred.resolve(value);
        value.dispose();
      } else {
        const error = context.newError({ name: "HostError", message: message.error });
        deferred.reject(error);
        error.dispose();
      }
      pump();
    } catch (error) {
      post({ t: "fatal", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (message.t === "call") {
    hostNow = message.now;
    try {
      const value = await invoke(message.hook, message.args);
      post({ t: "done", id: message.id, ok: true, value, cpuMs: Math.round(cpuSpent) });
    } catch (error) {
      post({
        t: "done",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        cpuMs: Math.round(cpuSpent),
      });
    }
  }
});

try {
  evaluate(prelude, "prelude.js");
  evaluate(code, "connector.js");
  /*
   * One endpoint's own module, in a function scope: it sees the shared code's
   * functions, its own names never clash with them, and its read, parse and
   * paginate become the run's.
   */
  if (typeof endpointCode === "string")
    evaluate(
      `(function () {\n${endpointCode}\n;if (typeof read === "function") globalThis.read = read;\nif (typeof parse === "function") globalThis.parse = parse;\nif (typeof paginate === "function") globalThis.paginate = paginate;\n})();`,
      "endpoint.js",
    );
  evaluate(
    `globalThis.__hooks = {
      authenticate: typeof authenticate === "function" ? authenticate : undefined,
      signRequest: typeof signRequest === "function" ? signRequest : undefined,
      read: typeof read === "function" ? read : undefined,
      paginate: typeof paginate === "function" ? paginate : undefined,
      parse: typeof parse === "function" ? parse : undefined,
    };
    globalThis.__hookNames = Object.keys(globalThis.__hooks).filter((name) => globalThis.__hooks[name]).join(",");`,
    "hooks.js",
  );
  const names = context.getProp(context.global, "__hookNames");
  const hooks = context.getString(names);
  names.dispose();
  post({ t: "ready", hooks: hooks === "" ? [] : hooks.split(",") });
} catch (error) {
  post({ t: "ready", error: error instanceof Error ? error.message : String(error) });
}
