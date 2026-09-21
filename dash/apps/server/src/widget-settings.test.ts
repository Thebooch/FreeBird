import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogEntrySchema,
  compileBrief,
  connectionSchema,
  entitySchema,
  resourceSchema,
} from "@freebirdai/dash-spec";
import { buildServer } from "./server.js";
import { CatalogStore } from "./catalog.js";
import { SpecStore } from "./store.js";
import { KeyStore, LocalAesVault } from "./vault.js";

/**
 * Changing a widget that is already on a board.
 *
 * The thing that was impossible: a widget's decisions lived on a draft, and
 * the draft was destroyed when it was added, so the only settings a finished
 * widget had were how it looked. Changing a column meant deleting it and
 * describing it again.
 *
 * What these guard is the pair of hazards that make an edit dangerous rather
 * than merely wrong — a recompile that loses what no brief can say, and one
 * that mints a new id and orphans the widget's place on the board.
 */

const entity = entitySchema.parse({
  id: "task",
  resource: "task",
  name: { one: "Task", many: "Tasks" },
  kind: "work",
  identity: { field: "Id", observed: true },
  display: { title: ["Title"], status: "Status" },
  views: { columns: ["Title", "Status"] },
  fields: [
    { path: "Id", visibility: "hidden" },
    { path: "Title", label: "Summary", visibility: "primary" },
    { path: "Status", label: "Status", visibility: "primary", values: ["Open", "Done"] },
    { path: "Priority", label: "Priority", visibility: "detail" },
  ],
});

const resource = resourceSchema.parse({ id: "task", title: "Tasks", listOp: "tasks_list" });

const entry = catalogEntrySchema.parse({
  id: "api",
  title: "The API",
  baseUrl: "https://api.example.com",
  dialect: { rowsPath: "$" },
  ops: [{ id: "tasks_list", title: "Tasks", path: "/tasks", fields: [] }],
  resources: [resource],
  entities: [entity],
});

const built = compileBrief({
  brief: { entity: "task", intent: "records" },
  entity,
  resource,
  connection: "api",
  id: "my-tasks",
}).widget!;

let dir: string;
let store: SpecStore;
let catalog: CatalogStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-settings-"));
  store = new SpecStore(join(dir, "dashboards"), join(dir, "connections"));

  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "api.json"), JSON.stringify(entry), "utf8");
  catalog = new CatalogStore(seed, join(dir, ".dash", "catalog"));

  store.putConnection(
    connectionSchema.parse({
      id: "api",
      title: "The API",
      kind: "rest",
      catalog: "api",
      baseUrl: "https://api.example.com",
      ops: [{ id: "tasks_list", title: "Tasks", path: "/tasks" }],
      resources: [resource],
    }),
  );
  store.putDashboard({
    specVersion: 1,
    id: "board",
    title: "Board",
    params: { filters: [] },
    widgets: [
      { ...built, presentation: { settings: { density: "compact" } }, confirmed: ["Cost:cents"] },
    ],
    layout: { gridCols: 12, cells: [{ widgetId: "my-tasks", x: 0, y: 0, w: 6, h: 6, locked: false }] },
    groups: [],
    presentation: {},
  } as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const app = () => {
  const keys = new KeyStore(new LocalAesVault(Buffer.alloc(32, 7)), join(dir, ".dash", "vault.json"));
  return buildServer({ store, keys, catalog });
};

describe("a widget's settings, after it is on a board", () => {
  it("offers what it could be changed to", async () => {
    const server = app();
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/dashboards/board/widgets/my-tasks/settings",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.brief).toMatchObject({ entity: "task", intent: "records" });
      expect(body.controls.map((one: { stepId: string }) => one.stepId)).toEqual(
        expect.arrayContaining(["title", "view", "columns", "filters", "sort"]),
      );
    } finally {
      await server.close();
    }
  });

  it("changes one thing and keeps the widget's place on the board", async () => {
    const server = app();
    try {
      const response = await server.inject({
        method: "PUT",
        url: "/api/dashboards/board/widgets/my-tasks/brief",
        payload: { stepId: "columns", values: ["Title", "Priority"] },
      });
      expect(response.statusCode).toBe(200);

      const saved = store.getDashboard("board")!.widgets[0]!;
      expect(saved.roles.columns).toEqual(["Title", "Priority"]);
      expect(saved.brief?.columns).toEqual(["Title", "Priority"]);
      /*
       * A fresh id would orphan the layout cell — and for a widget in a group,
       * drop the group below two members, which the dashboard schema refuses
       * outright, making the whole board unstorable.
       */
      expect(saved.id).toBe("my-tasks");
      expect(store.getDashboard("board")!.layout.cells[0]?.widgetId).toBe("my-tasks");
    } finally {
      await server.close();
    }
  });

  it("keeps what no brief can say", async () => {
    const server = app();
    try {
      await server.inject({
        method: "PUT",
        url: "/api/dashboards/board/widgets/my-tasks/brief",
        payload: { stepId: "title", values: ["Open work"] },
      });
      const saved = store.getDashboard("board")!.widgets[0]!;
      expect(saved.title).toBe("Open work");
      // Restyling and a confirmed unit are decisions somebody made on purpose,
      // outside the brief, and a recompile must not quietly discard them.
      expect(saved.presentation).toMatchObject({ settings: { density: "compact" } });
      expect(saved.confirmed).toEqual(["Cost:cents"]);
    } finally {
      await server.close();
    }
  });

  it("says plainly when a widget was not built from a request", async () => {
    const server = app();
    try {
      const board = store.getDashboard("board")!;
      store.putDashboard({
        ...board,
        widgets: [{ ...board.widgets[0]!, brief: undefined }],
      });

      const response = await server.inject({
        method: "GET",
        url: "/api/dashboards/board/widgets/my-tasks/settings",
      });
      expect(response.json()).toMatchObject({ brief: null, controls: [] });

      const refused = await server.inject({
        method: "PUT",
        url: "/api/dashboards/board/widgets/my-tasks/brief",
        payload: { stepId: "columns", values: ["Title"] },
      });
      expect(refused.statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });
});
