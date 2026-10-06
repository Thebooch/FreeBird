import type { ConnectorHook } from "@freebirdai/connect-spec";

/**
 * Where connector code runs. A plug-in point.
 *
 * `@freebirdai/connect-sandbox` runs each connector in a QuickJS interpreter
 * compiled to WebAssembly, in a worker thread of its own (`QuickJsSandbox`).
 * Without it the engine refuses generated connector code. A hosted
 * build supplies a stronger boundary — a separate process, or a microVM —
 * behind the same interface: nothing outside this file knows which.
 *
 * Whatever the implementation, the code inside can do nothing but compute and
 * ask its host (`SandboxHost`); every decision about what it may do is the
 * host's, made in the server's own process. See `host.ts`.
 */

export interface SandboxLimits {
  /** The interpreter's memory, in all. */
  readonly memoryBytes: number;
  /** Time spent running the code — not waiting on the host — before it is stopped. */
  readonly cpuMs: number;
  readonly stackBytes: number;
  /** Time the whole run may take, waiting included, before it is stopped whatever it is doing. */
  readonly wallMs: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memoryBytes: 64 * 1024 * 1024,
  cpuMs: 5_000,
  stackBytes: 512 * 1024,
  wallMs: 60_000,
};

/** What the code may ask for. Answers are JSON values; a refusal is a thrown error. */
export interface SandboxHost {
  call(name: string, args: unknown): Promise<unknown>;
  now(): number;
  log(line: string): void;
}

export type SessionHook = Extract<ConnectorHook, "authenticate" | "signRequest" | "read">;

export interface SandboxSession {
  /** The hooks the code defines. */
  readonly hooks: readonly ConnectorHook[];
  call(hook: SessionHook, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

export interface ConnectorSandbox {
  /** Load the code and stand ready to call its hooks. Rejects when the code does not load. */
  open(options: {
    readonly code: string;
    /**
     * One endpoint's own reading code, loaded after `code` in a scope of its
     * own: it sees the shared code's functions, and its own names never clash
     * with them. Its `read`, `parse` and `paginate` are the run's.
     */
    readonly module?: string;
    readonly host: SandboxHost;
    readonly limits?: Partial<SandboxLimits>;
    readonly seed?: number;
  }): Promise<SandboxSession>;
}

/** The code failed, or was stopped. The message is safe to show: it holds nothing the code was not given. */
export class SandboxError extends Error {
  readonly kind: "load" | "run" | "limit";
  constructor(kind: SandboxError["kind"], message: string) {
    super(message);
    this.name = "SandboxError";
    this.kind = kind;
  }
}

/**
 * The sandbox the engine uses when none is installed: every load is refused,
 * so generated connector code never runs anywhere it was not given a boundary.
 */
export const refusingSandbox: ConnectorSandbox = {
  open: async () => {
    throw new SandboxError(
      "load",
      "Connector code cannot run here: no sandbox is installed. Add @freebirdai/connect-sandbox to run it.",
    );
  },
};
