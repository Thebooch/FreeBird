import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drawnhub } from "@freebirdai/connect-bench/providers/drawnhub";
import { benchTransport } from "@freebirdai/connect-bench";
import { benchTooling } from "../../bench/integrator.js";
import { buildServer } from "../../server.js";
import { SpecStore } from "../../store.js";
import { discover, KeyStore, LocalAesVault } from "@freebirdai/connect/host";
import { BrowserDocsRenderer, type PlaywrightLike, RendererTooling } from "@freebirdai/connect-browser";

/*
 * Playwright's own Chromium, for documentation drawn by scripts: fetched
 * only once the person agrees, the answer kept; and a
 * page drawn with every request answered by the server's own reader.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-renderer-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A browser that is here, as far as the tooling can tell, and an installer that only says it ran. */
const standIns = () => {
  const installs: string[] = [];
  let finish: () => void = () => {};
  const install = (env: NodeJS.ProcessEnv, onProgress: (percent: number) => void) =>
    new Promise<void>((resolve) => {
      installs.push(env.PLAYWRIGHT_BROWSERS_PATH ?? "");
      onProgress(40);
      finish = resolve;
    });
  return { installs, install, finish: () => finish() };
};

describe("the browser for drawn documentation", () => {
  it("is fetched only once the person agrees, and the answer is kept", async () => {
    const { installs, install, finish } = standIns();
    const tooling = new RendererTooling({ dir, cache: join(dir, "no-browsers"), mode: "ask", install });
    expect(await tooling.readiness()).toBe("needs-install");
    expect(installs).toEqual([]);
    expect(tooling.status()).toMatchObject({ state: "missing", consented: false, downloadMb: 150 });

    expect(tooling.install()).toMatchObject({ state: "installing" });
    expect(tooling.status()).toMatchObject({ state: "installing", progress: 40, consented: true });
    expect(JSON.parse(readFileSync(join(dir, "renderer.json"), "utf8"))).toMatchObject({ download: "yes" });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));

    /* Agreed once: a browser missing again later is fetched without asking. */
    const later = new RendererTooling({ dir, cache: join(dir, "no-browsers"), mode: "ask", install });
    expect(later.consented()).toBe(true);
    await later.readiness();
    expect(installs).toHaveLength(2);
  });

  it("never downloads where it is not to: a hosted image says which command it lacks; off is off", async () => {
    const { installs, install } = standIns();
    const hosted = new RendererTooling({ dir, cache: join(dir, "no-browsers"), mode: "hosted", install });
    expect(await hosted.readiness()).toBe("unavailable");
    expect(hosted.status().error).toMatch(/npx playwright install chromium/);
    const off = new RendererTooling({ dir, cache: join(dir, "no-browsers"), mode: "off", install });
    expect(await off.readiness()).toBe("unavailable");
    expect(off.install()).toMatchObject({ state: "off" });
    expect(installs).toEqual([]);
    expect(existsSync(join(dir, "renderer.json"))).toBe(false);
  });

  it("says plainly when Chromium cannot start, with the command that fixes it", async () => {
    const load = async (): Promise<PlaywrightLike> => ({
      chromium: {
        launch: async () => {
          throw new Error("Host system is missing dependencies to run browsers.");
        },
      },
    });
    const tooling = new RendererTooling({ dir, mode: "ask", load });
    expect(await tooling.launch()).toBeNull();
    expect(tooling.status()).toMatchObject({ state: "failed" });
    expect(tooling.status().error).toMatch(/npx playwright install-deps chromium/);
    expect(await tooling.readiness()).toBe("unavailable");
  });
});

describe("asking the server about the browser", () => {
  it("says whether it is here, and starts the download only when asked", async () => {
    const { installs, install } = standIns();
    const tooling = new RendererTooling({ dir, cache: join(dir, "no-browsers"), mode: "ask", install });
    const store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"), join(dir, "reports"));
    const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 9)), join(dir, "vault.json"));
    const app = buildServer({ store, keys, rendererSetup: tooling });
    const before = (await app.inject({ method: "GET", url: "/api/discover/renderer" })).json();
    expect(before).toMatchObject({ state: "missing", consented: false, downloadMb: 150 });
    expect(installs).toEqual([]);
    const started = (await app.inject({ method: "POST", url: "/api/discover/renderer", payload: {} })).json();
    expect(started).toMatchObject({ state: "installing", consented: true });
    expect(installs).toHaveLength(1);
    const none = buildServer({ store, keys });
    expect((await none.inject({ method: "POST", url: "/api/discover/renderer", payload: {} })).statusCode).toBe(404);
    expect((await none.inject({ method: "GET", url: "/api/discover/renderer" })).json()).toMatchObject({ state: "off" });
    await app.close();
    await none.close();
  });
});

/* Live: only where Playwright's Chromium for this version is installed. The test never downloads it. */
describe.skipIf(benchTooling.status().state !== "ready")("a page drawn by its own script", () => {
  it("is drawn with every request answered by the server's reader, and its specification found", async () => {
    const transport = benchTransport([drawnhub]);
    const asked: string[] = [];
    const renderer = new BrowserDocsRenderer({
      tooling: benchTooling,
      fetch: async (url) => {
        asked.push(new URL(url).pathname);
        return { ...(await transport.fetchDocument(url)), contentType: null };
      },
    });
    const drawn = await renderer.render(drawnhub.docsUrl);
    expect(drawn?.html).toContain("drawnhub-openapi.json");
    expect(asked).toEqual(expect.arrayContaining(["/", "/assets/app.js", "/assets/reference.json"]));

    const found = await discover(drawnhub.docsUrl, { fetchDocument: transport.fetchDocument, llm: null, search: null, renderDocs: renderer });
    expect(found.source).toBe("openapi");
    expect(found.entry?.ops.map((op) => op.path)).toEqual(["/tickets"]);
  }, 60_000);
});
