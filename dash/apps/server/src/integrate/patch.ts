import {
  connectionSchema,
  type AuthSpec,
  type ConnectionSpec,
  type ConnectorSpec,
  type PaginationSpec,
  type CatalogEntry,
  type ReadSafety,
  type ResourceSpec,
} from "@freebirdai/dash-spec";

/**
 * A repair, in the connection's own vocabulary.
 *
 * Nothing here invents a capability: every field is one a connection already
 * has, so a repaired connection is exactly as expressive as one a person
 * configured by hand — and validated by the same schema before it is used.
 */
export interface ConnectionPatch {
  readonly baseUrl?: string;
  readonly auth?: AuthSpec;
  /** The API answers without signing in, where the specification declared no sign-in. */
  readonly authRequired?: false;
  /** Sent on every request: merged into the connection's shared headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent on every request: merged into the connection's shared query. */
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  /** Code for what the rest cannot express, with its authority. See `connector/`. */
  readonly connector?: ConnectorSpec;
  /** Per endpoint. */
  readonly ops?: Readonly<
    Record<
      string,
      {
        readonly rowsPath?: string;
        readonly pagination?: PaginationSpec;
        readonly maxPages?: number;
        readonly paginationChecked?: boolean;
        readonly servedBy?: "connector";
        readonly readSafety?: ReadSafety;
        /** Query parameters a read confirmed narrow the records by a field: parameter → field. */
        readonly filterParams?: Readonly<Record<string, string>>;
        /**
         * Values a read must send that no board supplies, from the documentation:
         * a search that matches everything, the earliest start time. A query
         * parameter's goes on the query string; a body, header or cookie
         * parameter's becomes its default; one the endpoint does not declare
         * goes into the body it already sends.
         */
        readonly inputs?: Readonly<Record<string, string | number | boolean>>;
      }
    >
  >;
  /** Per record type: an endpoint a read confirmed counts it. */
  readonly resources?: Readonly<Record<string, { readonly count: NonNullable<ResourceSpec["count"]> }>>;
  /**
   * A GraphQL endpoint read as if it were REST, replaced by the reads written
   * from the schema it answered with (`discovery/graphql.ts`).
   */
  readonly reads?: {
    /** The endpoint the reads stand in for. Absent, they are added beside what is there (an MCP server's tools). */
    readonly replace?: string;
    readonly ops: readonly CatalogEntry["ops"][number][];
    readonly resources: readonly ResourceSpec[];
  };
}

type OpDef = ConnectionSpec["ops"][number];

/** An endpoint sending the values a read must send: see `ConnectionPatch.ops[].inputs`. */
const withInputs = (op: OpDef, inputs: Readonly<Record<string, string | number | boolean>>): OpDef => {
  let next: OpDef = op;
  for (const [name, value] of Object.entries(inputs)) {
    const param = next.params.find((one) => one.name === name);
    if (param && param.in !== "query" && param.in !== "path") {
      next = { ...next, params: next.params.map((one) => (one.name === name ? { ...one, default: value } : one)) };
    } else if (!param && next.body?.type === "json" && next.body.template && typeof next.body.template === "object") {
      next = { ...next, body: { ...next.body, template: { ...(next.body.template as Record<string, unknown>), [name]: value } } };
    } else if (!param && next.body?.type === "graphql") {
      next = { ...next, body: { ...next.body, variables: { ...next.body.variables, [name]: value } } };
    } else if (!param || param.in === "query") {
      next = { ...next, query: { ...next.query, [name]: value } };
    }
  }
  return next;
};

export const applyPatch = (connection: ConnectionSpec, patch: ConnectionPatch): ConnectionSpec | null => {
  const dialect = connection.dialect ?? { headers: {}, query: {} };
  const next = {
    ...connection,
    ...(patch.baseUrl ? { baseUrl: patch.baseUrl, addressPending: false } : {}),
    ...(patch.auth ? { auth: patch.auth } : {}),
    ...(patch.authRequired === false ? { authRequired: false } : {}),
    ...(patch.connector ? { connector: patch.connector } : {}),
    dialect: {
      ...dialect,
      ...(patch.auth ? { auth: patch.auth } : {}),
      headers: { ...(dialect.headers ?? {}), ...(patch.headers ?? {}) },
      query: { ...(dialect.query ?? {}), ...(patch.query ?? {}) },
    },
    ops: connection.ops.map((op) => {
      const change = patch.ops?.[op.id];
      if (!change) return op;
      const { filterParams, inputs, ...rest } = change;
      const withFilters = {
        ...op,
        ...rest,
        ...(filterParams
          ? {
              params: (op.params ?? []).map((param) =>
                filterParams[param.name] ? { ...param, filters: filterParams[param.name] } : param,
              ),
            }
          : {}),
      };
      return inputs ? withInputs(withFilters, inputs) : withFilters;
    }),
    resources: connection.resources.map((resource) => {
      const change = patch.resources?.[resource.id];
      return change ? { ...resource, count: change.count } : resource;
    }),
  };
  /* Written as data for the schema to read: a catalog's op is a connection's, once parsed. */
  const withReads = (): unknown => {
    if (!patch.reads) return next;
    const { replace, ops, resources } = patch.reads;
    const kept = next.ops.filter((op) => op.id !== replace);
    const taken = new Set(kept.map((op) => op.id));
    const added = ops.filter((op) => !taken.has(op.id));
    const remaining = next.resources.filter((one) => one.listOp !== replace);
    const listed = new Set(remaining.map((one) => one.id));
    return {
      ...next,
      ops: [...kept, ...added],
      resources: [...remaining, ...resources.filter((one) => !listed.has(one.id) && added.some((op) => op.id === one.listOp))],
      ...(next.validateOpId === replace && added[0] ? { validateOpId: added[0].id } : {}),
    };
  };
  const parsed = connectionSchema.safeParse(withReads());
  return parsed.success ? parsed.data : null;
};

/** What a patch does, in words for the log a person can read. */
export const describePatch = (patch: ConnectionPatch, titleOf: (op: string) => string = (op) => op): string => {
  const parts: string[] = [];
  if (patch.baseUrl) parts.push(`address ${patch.baseUrl}`);
  if (patch.auth) {
    const auth = patch.auth;
    parts.push(
      auth.type === "bearer"
        ? "sign in with a bearer token"
        : auth.type === "header"
          ? `sign in with the ${auth.header} header${auth.template ? ` as “${auth.template.replace("{{key}}", "…")}”` : ""}`
          : auth.type === "query"
            ? `sign in with the ${auth.param} parameter`
            : auth.type === "basic"
              ? "sign in with a username and password"
              : auth.type === "connector"
                ? `sign in through the connector with ${auth.credentials.map((one) => one.label ?? one.name).join(" and ") || "no pasted value"}`
                : auth.type === "sigv4"
                  ? `sign each request for AWS${auth.region ? ` (${[auth.service, auth.region].filter(Boolean).join(", ")})` : ""}`
                  : `sign in: ${auth.type}`,
    );
  }
  if (patch.authRequired === false) parts.push("read without signing in");
  for (const [name, value] of Object.entries(patch.headers ?? {})) parts.push(`send ${name}: ${value}`);
  for (const [name, value] of Object.entries(patch.query ?? {})) parts.push(`send ${name}=${value}`);
  if (patch.connector)
    parts.push(
      `run connector code (${patch.connector.hash.slice(7, 19)}) that may reach ${patch.connector.authority.destinations.map((one) => one.host).join(", ")}${patch.connector.summary ? `: ${patch.connector.summary}` : ""}`,
    );
  for (const [op, change] of Object.entries(patch.ops ?? {})) {
    if (change.servedBy) parts.push(`read ${titleOf(op)} with the connector`);
    else if (change.rowsPath) parts.push(`read ${titleOf(op)} from ${change.rowsPath} in each response`);
    if (change.pagination)
      parts.push(
        change.pagination.kind === "none"
          ? `read ${titleOf(op)} in one response`
          : `read every page of ${titleOf(op)}`,
      );
    for (const [param, field] of Object.entries(change.filterParams ?? {}))
      parts.push(`ask ${titleOf(op)} for records by ${field} with ${param}`);
    for (const [name, value] of Object.entries(change.inputs ?? {})) parts.push(`send ${name}=${String(value)} to ${titleOf(op)}`);
  }
  if (patch.reads)
    parts.push(
      `read ${patch.reads.ops.length} list(s) from the GraphQL schema: ${patch.reads.ops
        .slice(0, 6)
        .map((op) => op.title)
        .join(", ")}${patch.reads.ops.length > 6 ? ", …" : ""}`,
    );
  for (const [resource, change] of Object.entries(patch.resources ?? {}))
    parts.push(
      `count ${resource} with ${titleOf(change.count.op)}${change.count.filters.length > 0 ? `, narrowed by ${change.count.filters.join(", ")}` : ""}`,
    );
  return parts.join("; ") || "no change";
};

/**
 * Whether two hosts belong to the same organisation.
 *
 * A repair may move a connection to another address the documentation names,
 * and the key goes with it — so only to a host under the same registrable
 * domain as the documentation or the address already in use. An approximate
 * public-suffix rule: the last two labels, or three under a two-letter
 * country code with a generic second level (`co.uk`, `com.au`).
 */
export const siteOf = (host: string): string => {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  const generic = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
  const take =
    labels.length >= 3 && labels[labels.length - 1]!.length === 2 && generic.has(labels[labels.length - 2]!)
      ? 3
      : 2;
  return labels.slice(-take).join(".");
};

export const sameSite = (a: string, b: string): boolean => siteOf(a) === siteOf(b);
