import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Principal } from "@freebirdai/dash-spec";
import type { FastifyInstance, InjectOptions } from "fastify";
import { isPublicUrl, publicWorkspaceOf } from "../identity/public.js";
import type { IdentityResolver } from "../identity/resolver.js";

/**
 * One server, several workspaces.
 *
 * Each workspace is answered by a server of its own — `buildServer` with that
 * workspace's stores: its connections, boards and keys in its own folders,
 * its rows in Dash's database under its own key, its chat under its own
 * tenant, its own keeper, cache, gate and jobs. Nothing is shared between two
 * of them but what was always everybody's: the shipped catalog, the registry
 * tier, the models and the databases' connections.
 *
 * The host only decides which of them a request is for: whoever the request
 * says sent it is a member of one workspace, and that workspace's server
 * answers. Each server checks again that the member is its own, so a request
 * can never reach another workspace's server by any route. A workspace nobody
 * has asked anything of for a while is closed, and built again when asked.
 *
 * The open-source build has one workspace and does not use this: it runs one
 * server, as it always has.
 */

export interface WorkspaceHostOptions {
  readonly identity: IdentityResolver;
  /** The server for one workspace, built the first time a member of it asks. */
  readonly build: (workspace: string) => FastifyInstance | Promise<FastifyInstance>;
  /**
   * Whether a workspace is real, for public pages: they name their workspace
   * in the path with nobody signed in, so a made-up name must not open a
   * server. Absent: every well-formed name is taken as real.
   */
  readonly exists?: (workspace: string) => Promise<boolean>;
  /** A workspace asked nothing for this long is closed. Twenty minutes unless said. */
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** What a workspace id must look like: it names folders and keys rows. */
const WORKSPACE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const isWorkspaceId = (id: string): boolean => WORKSPACE_ID.test(id);

const IDLE_MS = 20 * 60_000;

interface Held {
  readonly app: Promise<FastifyInstance>;
  usedAt: number;
}

export class WorkspaceHost {
  private readonly held = new Map<string, Held>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: WorkspaceHostOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The workspace's own server, ready to answer; built once. */
  async appFor(workspace: string): Promise<FastifyInstance> {
    if (!isWorkspaceId(workspace)) throw new Error(`"${workspace}" is not a workspace this host can hold.`);
    let held = this.held.get(workspace);
    if (!held) {
      const app = (async () => {
        const built = await this.options.build(workspace);
        await built.ready();
        this.options.log?.(`workspace ${workspace} is open`);
        return built;
      })();
      held = { app, usedAt: this.now() };
      this.held.set(workspace, held);
      app.catch(() => this.held.delete(workspace));
    }
    held.usedAt = this.now();
    return held.app;
  }

  /** A workspace a public page may name: well formed, and one this host has. */
  private async isReal(workspace: string): Promise<boolean> {
    if (!isWorkspaceId(workspace)) return false;
    if (this.held.has(workspace) || !this.options.exists) return true;
    return this.options.exists(workspace).catch(() => false);
  }

  /** Who sent a request, by the host's own resolver: null when nobody can be named. */
  private async principalOf(request: {
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly url: string;
  }): Promise<Principal | null> {
    return this.options.identity.resolve({ headers: request.headers, url: request.url });
  }

  /** One request, answered by its workspace's server, streaming and all. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      /* A public page names its workspace in the path and is answered with no principal (`identity/public.ts`). */
      if (isPublicUrl(request.url ?? "/")) {
        const workspace = publicWorkspaceOf(request.url ?? "/");
        if (!workspace || !(await this.isReal(workspace))) {
          response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found." }));
          return;
        }
        (await this.appFor(workspace)).routing(request, response);
        return;
      }
      const principal = await this.principalOf({ headers: request.headers, url: request.url ?? "/" });
      if (!principal || !isWorkspaceId(principal.workspaceId)) {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Sign in to continue." }));
        return;
      }
      const app = await this.appFor(principal.workspaceId);
      app.routing(request, response);
    } catch (error) {
      this.options.log?.(`a request could not be answered: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Something went wrong on this server." }));
    }
  }

  /** The same, in process: what tests and a caller without a socket use. */
  async inject(options: InjectOptions & { readonly headers?: Record<string, string> }): Promise<{ statusCode: number; json: () => unknown; body: string }> {
    const url = typeof options.url === "string" ? options.url : "/";
    if (isPublicUrl(url)) {
      const workspace = publicWorkspaceOf(url);
      if (!workspace || !(await this.isReal(workspace))) {
        const body = JSON.stringify({ error: "Not found." });
        return { statusCode: 404, body, json: () => JSON.parse(body) as unknown };
      }
      return (await this.appFor(workspace)).inject(options);
    }
    const principal = await this.principalOf({ headers: { ...options.headers }, url });
    if (!principal || !isWorkspaceId(principal.workspaceId)) {
      const body = JSON.stringify({ error: "Sign in to continue." });
      return { statusCode: 401, body, json: () => JSON.parse(body) as unknown };
    }
    return (await this.appFor(principal.workspaceId)).inject(options);
  }

  /** A server that listens, for a hosted build: every request through `handle`. */
  listen(port: number, host: string): Server {
    const server = createServer((request, response) => void this.handle(request, response));
    server.listen(port, host);
    this.sweeper ??= setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
    server.on("close", () => void this.close());
    return server;
  }

  /** Close every workspace nobody has asked anything of for a while. */
  async sweep(): Promise<void> {
    const idle = this.options.idleMs ?? IDLE_MS;
    for (const [workspace, held] of [...this.held]) {
      if (this.now() - held.usedAt < idle) continue;
      this.held.delete(workspace);
      await (await held.app.catch(() => null))?.close().catch(() => undefined);
      this.options.log?.(`workspace ${workspace} was closed, unused for ${Math.round(idle / 60_000)} minutes`);
    }
  }

  /** Which workspaces are open now. */
  open(): string[] {
    return [...this.held.keys()];
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    const all = [...this.held.values()];
    this.held.clear();
    for (const held of all) await (await held.app.catch(() => null))?.close().catch(() => undefined);
  }
}
