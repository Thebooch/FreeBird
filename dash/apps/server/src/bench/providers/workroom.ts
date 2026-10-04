import { json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, BenchResponse, MockProvider } from "../types.js";

/**
 * Workroom: tasks one workspace at a time.
 *
 * A list that needs an input another list supplies: tasks are listed one
 * workspace at a time, and the workspaces list gives their ids.
 *
 * Written for the kind of gap it tests, without reading any held-out provider.
 */

const WR_HOST = "api.workroom.bench.test";
const WR_KEY = "wr_key_6620";

export const wrWorkspaces = [
  { id: "ws_31", name: "Marketing" },
  { id: "ws_47", name: "Engineering" },
  { id: "ws_58", name: "Support" },
];

export const wrTasks = (() => {
  const next = random(9104);
  return Array.from({ length: 160 }, (_, index) => ({
    id: `task_${index + 1}`,
    workspace_id: wrWorkspaces[index % wrWorkspaces.length]!.id,
    title: `Task ${index + 1}`,
    status: pick(next, ["open", "done", "open", "blocked"] as const),
  }));
})();

const workroomSpec = {
  openapi: "3.0.3",
  info: { title: "Workroom", version: "1", description: "Tasks live in workspaces. List the workspaces, then a workspace's tasks." },
  servers: [{ url: `https://${WR_HOST}/v1` }],
  components: { securitySchemes: { key: { type: "http", scheme: "bearer" } } },
  security: [{ key: [] }],
  paths: {
    "/workspaces": {
      get: {
        summary: "List workspaces",
        responses: {
          "200": {
            description: "Every workspace.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { workspaces: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } },
                },
              },
            },
          },
        },
      },
    },
    "/tasks": {
      get: {
        summary: "List tasks",
        parameters: [{ name: "workspace_id", in: "query", required: true, description: "The workspace whose tasks to list.", schema: { type: "string" } }],
        responses: {
          "200": {
            description: "One workspace's tasks.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tasks: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { id: { type: "string" }, workspace_id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["open", "done", "blocked"] } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export const workroom: MockProvider = {
  id: "workroom",
  split: "dev",
  pattern: "A list that needs an input another list supplies: tasks are listed one workspace at a time, and the workspaces list gives their ids",
  hosts: [WR_HOST],
  docsUrl: `https://${WR_HOST}/openapi.json`,
  credentials: [WR_KEY],
  credentialLabels: ["API token"],
  reference: {
    connection: {
      id: "workroom",
      title: "Workroom",
      kind: "rest",
      baseUrl: `https://${WR_HOST}/v1`,
      auth: { type: "bearer", keyRef: "workroom-key" },
      ops: [
        { id: "workspaces", title: "List workspaces", path: "/workspaces", rowsPath: "$.workspaces" },
        {
          id: "tasks",
          title: "List tasks",
          path: "/tasks",
          rowsPath: "$.tasks",
          params: [{ name: "workspace_id", in: "query", required: true, valueFrom: { op: "workspaces", field: "id", each: true } }],
        },
      ],
    },
    secrets: { "workroom-key": WR_KEY },
  },
  objectives: [
    {
      id: "open-tasks",
      request: "How many tasks are open?",
      answer: wrTasks.filter((one) => one.status === "open").length,
      tolerance: 0,
      records: wrTasks.length,
      scripted: { path: "/tasks", measure: { agg: "count", where: 'status == "open"' } },
    },
    {
      id: "marketing-open-tasks",
      request: "How many tasks are open in the Marketing workspace?",
      answer: wrTasks.filter((one) => one.status === "open" && one.workspace_id === "ws_31").length,
      tolerance: 0,
      /* Every workspace's tasks: a read settled to Marketing's alone is narrowed by design (PROTOCOL.md). */
      records: wrTasks.length,
      /* Narrowed to the workspace too: a correct read of every workspace counts the same, and so does one of Marketing's alone. */
      scripted: { path: "/tasks", measure: { agg: "count", where: 'status == "open" && workspace_id == "ws_31"' } },
    },
  ],
  handle(request: BenchRequest): BenchResponse {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(workroomSpec);
    if (request.headers["authorization"] !== `Bearer ${WR_KEY}`) return json({ error: "a bearer token is required" }, 401);
    if (url.pathname === "/v1/workspaces") return json({ workspaces: wrWorkspaces });
    if (url.pathname === "/v1/tasks") {
      const workspace = url.searchParams.get("workspace_id");
      if (!workspace) return json({ error: "workspace_id is required" }, 400);
      return json({ tasks: wrTasks.filter((one) => one.workspace_id === workspace) });
    }
    return notFound();
  },
};
