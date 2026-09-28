import {
  connectionSchema,
  type AuthSpec,
  type ConnectionSpec,
  type ConnectorSpec,
  type PaginationSpec,
  type ReadSafety,
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
      }
    >
  >;
}

export const applyPatch = (connection: ConnectionSpec, patch: ConnectionPatch): ConnectionSpec | null => {
  const dialect = connection.dialect ?? { headers: {}, query: {} };
  const next = {
    ...connection,
    ...(patch.baseUrl ? { baseUrl: patch.baseUrl, addressPending: false } : {}),
    ...(patch.auth ? { auth: patch.auth } : {}),
    ...(patch.connector ? { connector: patch.connector } : {}),
    dialect: {
      ...dialect,
      ...(patch.auth ? { auth: patch.auth } : {}),
      headers: { ...(dialect.headers ?? {}), ...(patch.headers ?? {}) },
      query: { ...(dialect.query ?? {}), ...(patch.query ?? {}) },
    },
    ops: connection.ops.map((op) => {
      const change = patch.ops?.[op.id];
      return change ? { ...op, ...change } : op;
    }),
  };
  const parsed = connectionSchema.safeParse(next);
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
                : `sign in: ${auth.type}`,
    );
  }
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
  }
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
