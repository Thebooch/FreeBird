// @vitest-environment happy-dom
import { connectionSchema } from "@freebirdai/dash-spec";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionSummary } from "./api.js";
import { ConnectionManager } from "./ConnectionManager.jsx";
import { button, click, fakeServer, mount, settle, shown, unmountAll, type FakeServer } from "./testing/screen.js";

/**
 * The connections panel, as it opens: what is connected, and the buttons
 * beside each connection.
 *
 * A first pass over a very large screen. It holds the panel to drawing at
 * all, to asking nothing of anybody's API by being opened, and to what
 * Remove sends. The setup wizard behind "Add" is not covered here.
 */

const connection = (over: Record<string, unknown>, hasKey: boolean): ConnectionSummary => ({
  ...connectionSchema.parse({
    id: "acme",
    title: "Acme API",
    kind: "rest",
    baseUrl: "https://api.acme.test",
    auth: { type: "bearer", keyRef: "acme-key" },
    ops: [
      { id: "leases", title: "Leases", path: "/leases" },
      { id: "units", title: "Units", path: "/units" },
    ],
    ...over,
  }),
  hasKey,
});

let server: FakeServer;
let onChanged: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;
const open = async (routes: Parameters<typeof fakeServer>[0]) => {
  server = fakeServer({ "GET /api/catalog": [], ...routes });
  onChanged = vi.fn();
  onClose = vi.fn();
  mount(createElement(ConnectionManager, { onClose, onChanged }));
  await settle();
  return document.body;
};
const writes = () => server.calls.filter((one) => one.method !== "GET").map((one) => `${one.method} ${one.url}`);

afterEach(() => {
  unmountAll();
  server?.restore();
  document.body.innerHTML = "";
});

describe("the connections panel", () => {
  it("lists what is connected and says whether each has its key, reading two lists and nothing else", async () => {
    const page = await open({
      "GET /api/connections": [
        connection({}, true),
        connection({ id: "beta", title: "Beta API", baseUrl: "https://beta.test" }, false),
        connection({ id: "open", title: "Open data", baseUrl: "https://open.test", auth: { type: "none" } }, false),
      ],
    });
    const rows = [...page.querySelectorAll(".dash-conn-list > li")].map((row) => shown(row));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Acme API");
    expect(rows[0]).toContain("https://api.acme.test");
    expect(rows[0]).toContain("2 endpoint(s)");
    expect(rows[0]).toContain("key stored");
    expect(rows[1]).toContain("no key yet");
    expect(rows[2]).toContain("no key needed");

    expect(server.calls.map((one) => `${one.method} ${one.url}`).sort()).toEqual(["GET /api/catalog", "GET /api/connections"]);
    expect(writes()).toEqual([]);
    /* A key is never part of what the panel is sent or shows. */
    expect(shown(page)).not.toContain("acme-key");
  });

  it("says so when nothing is connected, and still offers to add", async () => {
    const page = await open({ "GET /api/connections": [] });
    expect(shown(page)).toContain("Nothing connected yet.");
    expect(page.querySelector('[data-testid="start-add"]')).not.toBeNull();
    expect(writes()).toEqual([]);
  });

  it("says what went wrong when the connections cannot be read", async () => {
    const page = await open({ "GET /api/connections": { status: 500, body: { error: "The connections folder could not be read." } } });
    expect(shown(page)).toContain("The connections folder could not be read.");
    expect(page.querySelector(".dash-conn-list > li")).toBeNull();
  });

  it("removes the connection named, reads the list again, and tells the page around it", async () => {
    const page = await open({
      "GET /api/connections": [connection({}, true), connection({ id: "beta", title: "Beta API" }, true)],
      "DELETE /api/connections/beta": { ok: true },
    });
    server.on("GET /api/connections", [connection({}, true)]);
    await click(button(page, "Remove Beta API"));
    await settle();
    expect(writes()).toEqual(["DELETE /api/connections/beta"]);
    expect(server.sent("GET /api/connections")).toHaveLength(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect([...page.querySelectorAll(".dash-conn-list__title")].map((one) => one.textContent)).toEqual(["Acme API"]);
  });

  it("keeps a connection the server would not remove, and says why", async () => {
    const page = await open({
      "GET /api/connections": [connection({}, true)],
      "DELETE /api/connections/acme": { status: 409, body: { error: "Three widgets still read this connection." } },
    });
    await click(button(page, "Remove Acme API"));
    await settle();
    expect(shown(page)).toContain("Three widgets still read this connection.");
    expect(onChanged).not.toHaveBeenCalled();
    expect([...page.querySelectorAll(".dash-conn-list__title")].map((one) => one.textContent)).toEqual(["Acme API"]);
  });

  it("closes on Escape", async () => {
    await open({ "GET /api/connections": [] });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
