import type { ActionContext, ActionDefinition, ActionPreviewContent, AuthContext, ComponentDefinition, LlmTool } from "@freebirdai/core";
import type { Connect, ReadResult, WriteActor, WriteIntent, WriteReview } from "@freebirdai/connect";
import { z } from "zod";

/**
 * Any API, from a FreeBird chat.
 *
 * A component and two tools over `@freebirdai/connect`. The tools answer
 * questions during the turn (what is connected, what its records hold); the
 * component's actions do what a person confirms (add an API, check it, change
 * a record). A change is shown as the engine's own review, field by field,
 * before anything is sent, and committed only as reviewed.
 *
 * A key never goes through the chat: whatever is said there reaches the model
 * and the conversation's history. The chat says a key is needed; the host
 * collects it in its own form (`connect.connections.setKey`, or
 * `PUT /connections/:id/key` from `@freebirdai/connect-server`).
 */

export interface ConnectKitOptions {
  /** Who is asking, from the chat's auth. Default: its `userId`, or the owner. */
  readonly actor?: (auth: AuthContext | undefined) => WriteActor;
  /**
   * May this person make this change? Asked before the review is shown and
   * again before it is sent, beside the engine's own `authorize`. Denials are
   * guide's: a 403 and an `action.unauthorized` event.
   */
  readonly authorize?: (actor: WriteActor, intent: WriteIntent) => boolean | Promise<boolean>;
  /** The most rows a read hands the model. Counts and totals still cover every row. Default 50. */
  readonly maxRows?: number;
  /** The component's id. Default `connectedApis`. */
  readonly componentId?: string;
}

const defaultActor = (auth: AuthContext | undefined): WriteActor => ({
  userId: auth?.userId ?? "owner",
  workspaceId: auth?.orgId ?? "local",
});

const measureSchema = z.object({
  agg: z.enum(["count", "sum", "avg", "min", "max"]).describe("How to combine the rows"),
  field: z.string().optional().describe("The numeric field to combine; not needed for a count"),
});

const readSchema = z.object({
  connection: z.string().describe("The connection's id, from connect_list_apis"),
  record: z.string().optional().describe("A record type by its id or name, e.g. 'invoice'. Use this when the API's record types are known"),
  op: z.string().optional().describe("Or an endpoint id, when no record type fits"),
  params: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Inputs the endpoint takes, by name"),
  filter: z.record(z.string(), z.unknown()).optional().describe("Keep only rows whose fields equal these values"),
  measure: measureSchema.optional().describe("Combine the rows into one number instead of listing them"),
  fresh: z.string().optional().describe("How old an answer may be: '30s', '5m', '1h'. Default 5m"),
});

const changeSchema = z.object({
  connection: z.string().describe("The connection's id"),
  entity: z.string().describe("The record type, by id or name"),
  kind: z.enum(["create", "update", "delete", "action"]).describe("What to do to the record"),
  id: z.string().optional().describe("The record's own id, for an update, delete or action"),
  action: z.string().optional().describe("For an action: which one"),
  parents: z.record(z.string(), z.string()).optional().describe("Ids of what the record lives under, by parameter"),
  values: z.record(z.string(), z.unknown()).optional().describe("Fields to set, by name"),
  review: z
    .object({
      pendingId: z.string(),
      digest: z.string(),
      title: z.string(),
      summary: z.string(),
      rows: z.array(z.object({ label: z.string(), value: z.string() })),
    })
    .optional()
    .describe("Filled in by the server with what will change. Never set this yourself."),
});

type ChangeArgs = z.infer<typeof changeSchema>;

/** A number from a row's field, where it holds one. */
const numberOf = (row: unknown, field: string): number | null => {
  let value: unknown = row;
  for (const part of field.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Rows combined into one number, over every row the read returned. */
export const measureRows = (rows: readonly unknown[], measure: z.infer<typeof measureSchema>): number | null => {
  if (measure.agg === "count") return rows.length;
  if (!measure.field) return null;
  const values = rows.map((row) => numberOf(row, measure.field!)).filter((n): n is number => n !== null);
  if (values.length === 0) return null;
  if (measure.agg === "sum") return values.reduce((a, b) => a + b, 0);
  if (measure.agg === "avg") return values.reduce((a, b) => a + b, 0) / values.length;
  if (measure.agg === "min") return Math.min(...values);
  return Math.max(...values);
};

/** The review, as rows on guide's confirmation card. */
const previewRows = (review: WriteReview): { label: string; value: string }[] =>
  review.rows
    .filter((row) => row.changed)
    .map((row) => ({
      label: row.label,
      value: row.before === null ? (row.after ?? "—") : `${row.before} → ${row.after ?? "(cleared)"}`,
    }));

const intentOf = (args: ChangeArgs): WriteIntent => ({
  connection: args.connection,
  entity: args.entity,
  kind: args.kind,
  ...(args.id ? { id: args.id } : {}),
  ...(args.action ? { action: args.action } : {}),
  ...(args.parents ? { parents: args.parents } : {}),
  ...(args.values ? { values: args.values } : {}),
});

/**
 * A guide component and chat tools over a Connect engine.
 *
 * ```ts
 * const kit = createConnectKit(connect);
 * registry.register(kit.component);
 * createChatEngine({ …, processingToolCatalog: kit.tools, executeExtraTool: kit.executeTool });
 * ```
 */
export const createConnectKit = (connect: Connect, options: ConnectKitOptions = {}) => {
  const actorOf = options.actor ?? defaultActor;
  const maxRows = options.maxRows ?? 50;
  const componentId = options.componentId ?? "connectedApis";

  /** Every connection, what it still needs, and the record types it knows. */
  const listApis = () =>
    connect.connections.list().map((connection) => ({
      id: connection.id,
      title: connection.title,
      ...connect.connections.status(connection.id),
      records: connect.records(connection.id).map((entity) => ({
        id: entity.id,
        name: entity.name.many,
        ...(entity.description ? { description: entity.description } : {}),
      })),
      ...(connect.records(connection.id).length === 0
        ? { endpoints: connection.ops.slice(0, 40).map((op) => ({ id: op.id, title: op.title })) }
        : {}),
    }));

  const read = async (args: z.infer<typeof readSchema>) => {
    const result: ReadResult = await connect.read(args.connection, {
      ...(args.record ? { record: args.record } : {}),
      ...(args.op ? { op: args.op } : {}),
      ...(args.params ? { params: args.params } : {}),
      ...(args.filter ? { filter: args.filter } : {}),
      ...(args.fresh ? { fresh: args.fresh } : {}),
    });
    /* `complete` only when the read is known to have reached its end: a count over part of the records is not a total. */
    const base = { count: result.rows.length, complete: result.complete, warnings: result.warnings, fromMemory: result.cache === "hit" };
    if (args.measure) return { ...base, value: measureRows(result.rows, args.measure), measure: args.measure };
    return { ...base, rows: result.rows.slice(0, maxRows), ...(result.rows.length > maxRows ? { shown: maxRows } : {}) };
  };

  const tools: Record<string, LlmTool> = {
    connect_list_apis: {
      name: "connect_list_apis",
      description:
        "List the APIs connected here: each one's id, whether it still needs a key, and the record types (or, before they are known, the endpoints) it can read.",
      schema: z.object({}),
    },
    connect_read: {
      name: "connect_read",
      description:
        "Read records from a connected API to answer a question: by record type or endpoint, filtered, optionally combined into one number (count, sum, average, min, max). Reads only; never changes anything.",
      schema: readSchema,
    },
  };

  const executeTool = async (name: string, args: unknown, _ctx?: { auth: AuthContext; sessionId: string }): Promise<unknown> => {
    try {
      if (name === "connect_list_apis") return { apis: listApis() };
      if (name === "connect_read") return await read(readSchema.parse(args));
      return { error: `No tool named ${name}.` };
    } catch (error) {
      /* Said to the model in the engine's own words, so it can tell the person. */
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  const authorizeChange = async (args: ChangeArgs, ctx: ActionContext<unknown>) =>
    options.authorize ? options.authorize(actorOf(ctx.auth as AuthContext | undefined), intentOf(args)) : true;

  const actions: ActionDefinition<any, any, unknown>[] = [
    {
      id: "add_api",
      description:
        "Connect a new API from its documentation or OpenAPI address, an MCP server, or its name. Afterwards, tell the person if it needs a key: they enter it in the site's own form, never in the chat.",
      schema: z.object({
        from: z.string().describe("The API's documentation or OpenAPI URL, or its name"),
      }),
      requiresConfirmation: "preview",
      handler: async (args: { from: string }) => {
        const added = await connect.connections.add({ from: args.from });
        const status = connect.connections.status(added.id);
        return {
          id: added.id,
          title: added.title,
          endpoints: added.ops.length,
          needsKey: status.needsKey,
          needsAddress: status.needsAddress,
          note: added.discovery.note,
        };
      },
    },
    {
      id: "check_api",
      description:
        "Check a connected API: read the endpoints that matter, repair what its documentation got wrong, and work out its record types. Reads only.",
      schema: z.object({ connection: z.string().describe("The connection's id") }),
      requiresConfirmation: "none",
      handler: async (args: { connection: string }) => {
        const run = await connect.integrate(args.connection);
        if ("error" in run) return { ok: false, error: run.error };
        return {
          ok: true,
          outcome: run.outcome,
          changes: run.changes,
          records: connect.records(args.connection).map((entity) => entity.name.many),
        };
      },
    },
    {
      id: "change_record",
      description:
        "Create, update, delete or act on one record in a connected API. The person sees exactly what will change before anything is sent.",
      schema: changeSchema,
      requiresConfirmation: "strict",
      authorize: authorizeChange,
      /* The engine's review, made before the card is shown, so the card is the change itself. */
      preflight: async (args: ChangeArgs, ctx: ActionContext<unknown>) => {
        /* Asked before the record is read for the review, not only before it is sent. */
        if (!(await authorizeChange(args, ctx)))
          return { ok: false, message: "That change is not allowed here.", blockers: [{ code: "NOT_ALLOWED", message: "That change is not allowed here." }] };
        try {
          const review = await connect.writes.prepare(intentOf(args), actorOf(ctx.auth as AuthContext | undefined), {
            sessionId: ctx.sessionId,
          });
          return {
            ok: true,
            resolvedArgs: {
              review: {
                pendingId: review.pendingId,
                digest: review.digest,
                title: review.title,
                summary: [review.summary, ...review.warnings].join(" "),
                rows: previewRows(review),
              },
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, message, blockers: [{ code: "CHANGE_REFUSED", message }] };
        }
      },
      preview: (args: ChangeArgs): ActionPreviewContent =>
        args.review
          ? { title: args.review.title, summary: args.review.summary, rows: args.review.rows }
          : { title: "Change a record", summary: "The change is being prepared.", rows: [] },
      /*
       * The review is asked for again rather than taken from the card: within
       * the conversation it is the same one, and nothing the model wrote into
       * the arguments can change what is sent.
       */
      handler: async (args: ChangeArgs, ctx: ActionContext<unknown>) => {
        const actor = actorOf(ctx.auth as AuthContext | undefined);
        const review = await connect.writes.prepare(intentOf(args), actor, { sessionId: ctx.sessionId });
        const result = await connect.writes.commit(review, actor);
        return { status: result.status, title: result.title, changed: result.changed };
      },
    },
  ];

  const component: ComponentDefinition = {
    id: componentId,
    title: "Connected APIs",
    description:
      "The third-party APIs connected here, and what can be read and changed in each. Use it to connect an API, check one, or change a record.",
    tags: ["api", "integration", "records"],
    grid: { minW: 4, minH: 3, maxW: 12, defaultAspect: "wide" },
    dataSource: async () => ({ apis: listApis() }),
    actions,
    processingTools: Object.keys(tools),
    knowledge: [
      { text: "Answer questions about a connected API's records with connect_read; never guess numbers." },
      { text: "API keys are entered in the site's own form, never in the chat. If a connection needs a key, say so." },
    ],
  };

  return { component, tools, executeTool, listApis };
};

export type ConnectKit = ReturnType<typeof createConnectKit>;
