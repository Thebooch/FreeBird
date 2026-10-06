import { json, notFound, pick, random } from "../seed.js";
import type { BenchRequest, MockProvider } from "../types.js";

/**
 * Taskpad: a project API that refuses any request without its version header.
 *
 * The pattern: the specification declares `Taskpad-Version` as a required
 * header parameter with exactly one allowed value. The importer does not carry
 * header parameters into a connection, so every read is a 400 until something
 * sends it — a fix that needs no person, since the value is in the docs.
 */

const KEY = "tp_4c0ffee";
const HOST = "api.taskpad.bench.test";
const VERSION = "2024-06-01";

const tasks = (() => {
  const next = random(2202);
  return Array.from({ length: 57 }, (_, index) => ({
    id: index + 1,
    title: `Task ${index + 1}`,
    status: pick(next, ["todo", "doing", "done", "done"] as const),
    assignee: pick(next, ["ana", "bo", "cy", null] as const),
  }));
})();

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Taskpad", version: VERSION },
  servers: [{ url: `https://${HOST}` }],
  components: {
    securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" } },
    parameters: {
      Version: {
        name: "Taskpad-Version",
        in: "header",
        required: true,
        description: "The API version this request is written against.",
        schema: { type: "string", enum: [VERSION] },
      },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/tasks": {
      get: {
        operationId: "listTasks",
        summary: "List tasks",
        parameters: [{ $ref: "#/components/parameters/Version" }],
        responses: {
          "200": {
            description: "Every task.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      title: { type: "string" },
                      status: { type: "string", enum: ["todo", "doing", "done"] },
                      assignee: { type: "string", nullable: true },
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

export const taskpad: MockProvider = {
  id: "taskpad",
  split: "dev",
  pattern: "Required version header declared as a header parameter; API key in a header",
  hosts: [HOST],
  docsUrl: `https://${HOST}/openapi.json`,
  credentials: [KEY],
  reference: {
    connection: {
      id: "taskpad",
      title: "Taskpad",
      kind: "rest",
      baseUrl: `https://${HOST}`,
      auth: { type: "header", header: "X-Api-Key", keyRef: "taskpad-key" },
      ops: [{ id: "tasks", title: "List tasks", path: "/tasks", headers: { "Taskpad-Version": VERSION } }],
    },
    secrets: { "taskpad-key": KEY },
  },
  objectives: [
    {
      id: "done-count",
      request: "How many tasks are done?",
      answer: tasks.filter((one) => one.status === "done").length,
      tolerance: 0,
      records: tasks.length,
      scripted: { path: "/tasks", measure: { agg: "count", where: 'status == "done"' } },
    },
  ],
  handle(request: BenchRequest) {
    const { url } = request;
    if (url.pathname === "/openapi.json") return json(SPEC);
    if (request.headers["x-api-key"] !== KEY) return json({ error: "bad key" }, 401);
    if (request.headers["taskpad-version"] !== VERSION)
      return json({ error: "Taskpad-Version header is required" }, 400);
    if (url.pathname === "/tasks") return json(tasks);
    return notFound();
  },
};
