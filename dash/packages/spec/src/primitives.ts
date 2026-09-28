import { z } from "zod";

/**
 * Shared by connections and dialects. Kept in its own module so the dependency
 * order stays a straight line: primitives → dialect → connection.
 */

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "ids must be [a-zA-Z0-9_-]");

/**
 * How a connection proves who it is. The secret itself never appears in a
 * spec file — `keyRef` names an entry in the encrypted vault, and the public
 * API only ever reports whether that entry exists.
 */
/**
 * What the API's own documentation calls a credential — "Access key",
 * "Client secret", "Personal token" — so the person pasting it in is asked
 * for the thing they are looking at in the vendor's settings page, not for a
 * generic "API key" that may be one of two values they hold.
 */
const credentialLabel = z.string().min(1).max(80).optional();

/**
 * What a connector's code calls a credential: `secret`, `key_id`, `session`.
 * A name, never a value — the code asks the server to use the credential of
 * that name, and the server decides whether it may (see `connector.ts`).
 */
export const credentialNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "credential names are lowercase [a-z0-9_], starting with a letter");

export const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), keyRef: idSchema, label: credentialLabel }),
  z.object({
    type: z.literal("header"),
    header: z.string().min(1),
    keyRef: idSchema,
    /** e.g. "Token {{key}}" — `{{key}}` is the only token allowed here. */
    template: z.string().optional(),
    label: credentialLabel,
  }),
  z.object({
    type: z.literal("query"),
    param: z.string().min(1),
    keyRef: idSchema,
    label: credentialLabel,
  }),
  /**
   * HTTP Basic: a username and a password, joined and sent together.
   *
   * On most APIs that use it, *both* halves are credentials the person holds
   * — Rentvine sends "the access key as the username and secret as the
   * password" — so the username is a vault entry like the password
   * (`usernameRef`), asked for beside it. `username` is a fixed value for the
   * rarer API that documents one, and for connections saved before the
   * username could be a secret; `usernameRef` wins when both are present.
   */
  z.object({
    type: z.literal("basic"),
    username: z.string().min(1).optional(),
    usernameRef: idSchema.optional(),
    keyRef: idSchema,
    /** What the docs call the username, e.g. "Access key". */
    usernameLabel: credentialLabel,
    /** What the docs call the password, e.g. "Secret". */
    label: credentialLabel,
  }),
  /**
   * Two or more secret headers sent together.
   *
   * Client-id + client-secret pairs are common enough to need first-class
   * support — Buildium sends `x-buildium-client-id` and
   * `x-buildium-client-secret`, and neither alone authenticates anything.
   * Modelling that as a single `header` forces the user to smuggle both
   * values into one field, which cannot work.
   *
   * Each part has its own `keyRef`, so the two secrets are encrypted and
   * rotated independently rather than being concatenated into one blob.
   */
  z.object({
    type: z.literal("headers"),
    parts: z
      .array(
        z.object({
          header: z.string().min(1),
          keyRef: idSchema,
          /** What to call this field in the UI, e.g. "Client ID". */
          label: z.string().optional(),
          /** e.g. "Token {{key}}" — `{{key}}` is the only token allowed. */
          template: z.string().optional(),
        }),
      )
      .min(1)
      .max(4),
  }),
  /**
   * OAuth 2.0: a token obtained, kept and renewed by the server.
   *
   * `authorization_code` is somebody signing in with the provider once, with
   * PKCE; `client_credentials` is an app signing in as itself, with nobody
   * involved. Either way the only values a person holds are the app's own —
   * its client id and secret, from wherever they registered it (or supplied
   * by a hosted build that registered it for them). The access and refresh
   * tokens are the broker's: fetched, stored in the vault under `keyRef` and
   * `refreshRef`, renewed before they expire and after a refusal, and never
   * asked of anybody.
   */
  z.object({
    type: z.literal("oauth2"),
    flow: z.enum(["authorization_code", "client_credentials"]),
    authorizeUrl: z.string().url().optional(),
    tokenUrl: z.string().url(),
    scopes: z.array(z.string().min(1).max(200)).max(50).default([]),
    clientIdRef: idSchema,
    clientSecretRef: idSchema.optional(),
    /** Where the access token is kept. The broker's, never pasted. */
    keyRef: idSchema,
    /** Where the refresh token is kept, for the sign-in flow. */
    refreshRef: idSchema.optional(),
    /** How the app proves itself at the token endpoint: in the form, or as HTTP Basic. */
    clientAuth: z.enum(["body", "basic"]).default("body"),
    clientIdLabel: credentialLabel,
    clientSecretLabel: credentialLabel,
  }),
  /**
   * A sign-in only a connector's code can perform: a signed request, a login
   * for a session token. The values the person pastes are listed here, each
   * under the name the code uses for it; the code never receives one. It asks
   * the server to sign with one, or to put one in a request, and the server
   * does so only for the addresses the connector's authority binds it to.
   *
   * `tokens` are what a token exchange obtained — a session token kept in the
   * vault like OAuth's, and never asked of anybody.
   */
  z.object({
    type: z.literal("connector"),
    credentials: z
      .array(
        z.object({
          name: credentialNameSchema,
          keyRef: idSchema,
          label: credentialLabel,
          hint: z.string().max(200).optional(),
          /**
           * False for an identifier rather than a secret — a key ID, an account
           * number — which the code may read, to put in something it signs.
           * Never a password, a secret or a token: the server refuses to hand
           * over one named like one.
           */
          secret: z.boolean().optional(),
        }),
      )
      .max(6)
      .default([]),
    tokens: z.array(z.object({ name: credentialNameSchema, keyRef: idSchema })).max(4).default([]),
  }),
]);

export type AuthSpec = z.infer<typeof authSchema>;

/** The OAuth variant, by name. */
export type OAuthSpec = Extract<AuthSpec, { type: "oauth2" }>;

/** Stable, bounded vault names without collisions between long connection ids. */
export const connectionKeyRef = (connection: string, part?: number): string => {
  const base =
    connection.length > 48 ? `${connection.slice(0, 36)}-${fnv1a(connection)}` : connection;
  return `${base}-key${part === undefined ? "" : `-${part}`}`;
};

/**
 * Every secret this auth style needs, in UI order.
 *
 * Callers must go through this rather than reading `auth.keyRef`: that field
 * does not exist on every variant, and code that assumes one secret per
 * connection silently mishandles the multi-header case.
 */
export const authKeyRefs = (auth: AuthSpec): string[] => {
  switch (auth.type) {
    case "none":
      return [];
    case "headers":
      return auth.parts.map((part) => part.keyRef);
    case "basic":
      return auth.usernameRef ? [auth.usernameRef, auth.keyRef] : [auth.keyRef];
    case "oauth2":
      /* What a person holds: the app's own values. The tokens are `authTokenRefs`. */
      return auth.clientSecretRef ? [auth.clientIdRef, auth.clientSecretRef] : [auth.clientIdRef];
    case "connector":
      return auth.credentials.map((credential) => credential.keyRef);
    default:
      return [auth.keyRef];
  }
};

/**
 * Where a sign-in keeps what it obtained rather than what anybody pasted:
 * OAuth's access and refresh tokens. Removed with the connection like any
 * other secret, and never asked for.
 */
export const authTokenRefs = (auth: AuthSpec): string[] =>
  auth.type === "oauth2"
    ? [auth.keyRef, ...(auth.refreshRef ? [auth.refreshRef] : [])]
    : auth.type === "connector"
      ? auth.tokens.map((token) => token.keyRef)
      : [];

/**
 * The same auth with every vault name replaced, in `authKeyRefs` order.
 *
 * One function for every variant, so code that gives a connection its own
 * vault names — creating one from the catalog, migrating old ones — cannot
 * forget a secret that lives somewhere other than `keyRef`. It did, once:
 * a Basic username became a secret and would have kept the catalog's
 * placeholder name.
 */
export const rekeyAuth = (
  auth: AuthSpec,
  name: (previous: string, index: number, count: number) => string,
): AuthSpec => {
  const count = authKeyRefs(auth).length;
  switch (auth.type) {
    case "none":
      return auth;
    case "headers":
      return {
        ...auth,
        parts: auth.parts.map((part, index) => ({ ...part, keyRef: name(part.keyRef, index, count) })),
      };
    case "basic":
      return auth.usernameRef
        ? {
            ...auth,
            usernameRef: name(auth.usernameRef, 0, count),
            keyRef: name(auth.keyRef, 1, count),
          }
        : { ...auth, keyRef: name(auth.keyRef, 0, count) };
    case "oauth2": {
      /* The tokens follow the client id's new name, so every secret is this connection's own. */
      const clientIdRef = name(auth.clientIdRef, 0, count);
      const stem = clientIdRef.slice(0, 54);
      return {
        ...auth,
        clientIdRef,
        ...(auth.clientSecretRef ? { clientSecretRef: name(auth.clientSecretRef, 1, count) } : {}),
        keyRef: `${stem}-token`,
        ...(auth.refreshRef ? { refreshRef: `${stem}-refresh` } : {}),
      };
    }
    case "connector": {
      const credentials = auth.credentials.map((credential, index) => ({
        ...credential,
        keyRef: name(credential.keyRef, index, count),
      }));
      /* Tokens follow the first credential's new name, as OAuth's follow the client id's. */
      const stem = (credentials[0]?.keyRef ?? auth.tokens[0]?.keyRef ?? "connector").slice(0, 40);
      return {
        ...auth,
        credentials,
        tokens: auth.tokens.map((token) => ({ ...token, keyRef: `${stem}-${token.name}`.slice(0, 64) })),
      };
    }
    default:
      return { ...auth, keyRef: name(auth.keyRef, 0, count) };
  }
};

/** One thing the person must paste in, with what to call it. */
export interface AuthCredential {
  readonly keyRef: string;
  readonly label: string;
  /** Where it goes, for the curious — "Sent as the X-Api-Key header." */
  readonly hint: string;
}

/**
 * Every credential this auth needs, labelled, in the order to ask for them.
 *
 * The labels are the documentation's own where the import found them, and a
 * plain description of the slot where it did not — never just "API key" for
 * a value that is one half of a pair.
 */
export const authCredentials = (auth: AuthSpec): AuthCredential[] => {
  switch (auth.type) {
    case "none":
      return [];
    case "bearer":
      return [{ keyRef: auth.keyRef, label: auth.label ?? "API token", hint: "Sent as a bearer token." }];
    case "header":
      return [
        {
          keyRef: auth.keyRef,
          label: auth.label ?? "API key",
          hint: `Sent as the ${auth.header} header.`,
        },
      ];
    case "query":
      return [
        {
          keyRef: auth.keyRef,
          label: auth.label ?? "API key",
          hint: `Sent as the ${auth.param} query parameter.`,
        },
      ];
    case "basic":
      return [
        ...(auth.usernameRef
          ? [
              {
                keyRef: auth.usernameRef,
                label: auth.usernameLabel ?? "Username",
                hint: "Sent as the username in HTTP Basic authentication.",
              },
            ]
          : []),
        {
          keyRef: auth.keyRef,
          label: auth.label ?? "Password",
          hint: auth.usernameRef
            ? "Sent as the password in HTTP Basic authentication."
            : `Sent as the password in HTTP Basic authentication, with the username "${auth.username ?? ""}".`,
        },
      ];
    case "headers":
      return auth.parts.map((part) => ({
        keyRef: part.keyRef,
        label: part.label ?? part.header,
        hint: `Sent as the ${part.header} header.`,
      }));
    case "oauth2":
      return [
        {
          keyRef: auth.clientIdRef,
          label: auth.clientIdLabel ?? "Client ID",
          hint: "Your app's client ID, from where the app was registered with this service.",
        },
        ...(auth.clientSecretRef
          ? [
              {
                keyRef: auth.clientSecretRef,
                label: auth.clientSecretLabel ?? "Client secret",
                hint: "Your app's client secret. Only ever sent to the service's own sign-in address.",
              },
            ]
          : []),
      ];
    case "connector":
      return auth.credentials.map((credential) => ({
        keyRef: credential.keyRef,
        label: credential.label ?? credential.name,
        hint:
          credential.hint ??
          "Used to sign in on this connection's behalf. The connection's own code never sees it.",
      }));
  }
};

/* ── where an API lives ───────────────────────────────────────────────── */

/**
 * A part of an API's address that differs from one account to the next.
 *
 * Read from an OpenAPI `servers[].variables` entry, or from documentation that
 * writes the address with a placeholder — `https://{account}.rentvine.com`.
 * Many business APIs are hosted per customer, and without this the only
 * address an import could record was a placeholder host nobody's account
 * lives on.
 */
export const serverVariableSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
  /** What to call it when asking, e.g. "Account subdomain". */
  label: z.string().max(80).optional(),
  /** The documentation's own explanation. */
  description: z.string().max(300).optional(),
  /** The documented default. Often a placeholder like "example" — see `looksLikePlaceholder`. */
  default: z.string().max(200).optional(),
  /** When the documentation lists the only values allowed. */
  options: z.array(z.string().min(1).max(200)).max(50).optional(),
});

export type ServerVariable = z.infer<typeof serverVariableSchema>;

export const serverTemplateSchema = z.object({
  /** The address with `{name}` where each account differs. */
  url: z.string().min(1).max(500),
  variables: z.array(serverVariableSchema).max(8).default([]),
});

export type ServerTemplate = z.infer<typeof serverTemplateSchema>;

/**
 * What one value may contain.
 *
 * A subdomain, a region, a version, a tenant id — never a slash, an `@`, a
 * colon or a space, any of which could move a request to a different host
 * than the one the template names.
 */
export const SERVER_VALUE = /^[A-Za-z0-9._~-]{1,100}$/;

const TEMPLATE_TOKEN = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/** The `{name}`s in an address template, in order. */
export const templateVariableNames = (url: string): string[] => [
  ...new Set([...url.matchAll(TEMPLATE_TOKEN)].map((match) => match[1]!)),
];

/**
 * A documented default that is really a placeholder.
 *
 * Specs have to put *something* in `default`, and for a per-customer
 * subdomain they put "example", "your-company", "{subdomain}". Filling that
 * in would send a new connection's first request to a host nobody's account
 * lives on — so it is offered as a hint and the value is left for the person.
 */
export const looksLikePlaceholder = (variable: ServerVariable): boolean => {
  const value = variable.default?.trim().toLowerCase();
  if (!value) return true;
  if (variable.options && variable.options.length > 0) return false;
  return (
    value === variable.name.toLowerCase() ||
    /^(example|sample|demo|test|your|my|acme|company|account|subdomain|tenant|instance|domain|x{2,}|<|\{)/.test(
      value,
    )
  );
};

/**
 * Put values into an address template.
 *
 * Reports what is missing and what was refused rather than producing a
 * half-filled address: a request to `https://.rentvine.com` is not a
 * slower way of failing, it is a request to somebody else.
 */
export const resolveServerUrl = (
  template: ServerTemplate,
  values: Readonly<Record<string, string>>,
): { readonly url?: string; readonly missing: string[]; readonly invalid: string[] } => {
  const missing: string[] = [];
  const invalid: string[] = [];
  const byName = new Map(template.variables.map((variable) => [variable.name, variable]));
  for (const name of templateVariableNames(template.url)) {
    const value = values[name]?.trim() ?? "";
    const variable = byName.get(name);
    if (value === "") missing.push(name);
    else if (!SERVER_VALUE.test(value)) invalid.push(name);
    else if (variable?.options && variable.options.length > 0 && !variable.options.includes(value))
      invalid.push(name);
  }
  if (missing.length > 0 || invalid.length > 0) return { missing, invalid };
  const url = template.url.replace(TEMPLATE_TOKEN, (_raw, name: string) => values[name]!.trim());
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { missing, invalid: ["url"] };
    }
    return { url: url.replace(/\/+$/, ""), missing, invalid };
  } catch {
    return { missing, invalid: ["url"] };
  }
};

/**
 * Pagination is declared, never inferred.
 *
 * A wrong guess here does not produce an error — it produces the first page
 * and a chart that is quietly incomplete, which is the worst failure mode
 * this product has. The agent may propose a strategy, but it is surfaced for
 * confirmation rather than applied silently.
 */
/**
 * The most pages one read may fetch, whatever its strategy claims.
 *
 * One constant, because the catalog, the dialect and the endpoint each carry a
 * limit, and a catalog entry that allowed more than an endpoint does was
 * copied into a connection the endpoint schema then refused.
 */
export const MAX_PAGES = 50;

/**
 * Where a paging rule's parameters go: the query string, or the read's body
 * (a dotted path, `page.after`, into a JSON body or GraphQL's variables).
 */
const pagingLocation = z.enum(["query", "body"]).optional();

export const paginationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("cursor"),
    /**
     * Path to the next cursor. Supports `$.data[last].id` for the very common
     * case where the cursor is simply the last record's id.
     */
    cursorPath: z.string().min(1),
    param: z.string().min(1),
    hasMorePath: z.string().optional(),
    in: pagingLocation,
  }),
  z.object({
    kind: z.literal("offset"),
    param: z.string().min(1),
    limitParam: z.string().min(1),
    pageSize: z.number().int().min(1).max(1000),
    in: pagingLocation,
  }),
  z.object({
    kind: z.literal("page"),
    param: z.string().min(1),
    startsAt: z.number().int().min(0).default(1),
    limitParam: z.string().optional(),
    pageSize: z.number().int().min(1).max(1000).optional(),
    in: pagingLocation,
  }),
  z.object({ kind: z.literal("link-header") }),
]);

export type PaginationSpec = z.infer<typeof paginationSchema>;

/** The request parameters a paging rule sets itself, so nothing else may. */
export const pagingParamNames = (pagination: PaginationSpec | undefined): string[] =>
  pagination?.kind === "offset"
    ? [pagination.param, pagination.limitParam]
    : pagination?.kind === "page"
      ? [pagination.param, ...(pagination.limitParam ? [pagination.limitParam] : [])]
      : pagination?.kind === "cursor"
        ? [pagination.param]
        : [];

export const queryValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * What an endpoint accepts, and — more usefully — what each input *does*.
 *
 * `role` is the load-bearing field. Every vendor spells the same idea
 * differently: `q` / `search` / `filter`, `since` / `start_date` / `created[gte]`.
 * Recording the role once means the rest of the product can offer "search this
 * endpoint" or "narrow this to a date range" without any caller knowing the
 * vendor's vocabulary. It is the same abstraction `pagination.kind` and
 * `dialect.timeFilter` already apply connection-wide, pushed down to one op.
 *
 * `in` is limited to path and query on purpose: a secret belongs in the auth
 * config, not in a per-op header the UI would invite someone to fill in.
 */
export const PARAM_LOCATIONS = ["path", "query", "header", "cookie", "body"] as const;

export const paramDefSchema = z.object({
  name: z.string().min(1).max(120),
  /**
   * Where the value goes. A header or cookie parameter is an ordinary input
   * — a version, an account — never a secret, which belongs in the auth
   * config. A body parameter is filled into the read's body template by its
   * `{{param.x}}` token.
   */
  in: z.enum(PARAM_LOCATIONS),
  /** An `array` takes several values, given as a list or as text separated by commas. */
  type: z.enum(["string", "number", "boolean", "date", "array"]).default("string"),
  /**
   * How a list is written into the query string, OpenAPI's names:
   * `form` (`a=1&a=2`, or `a=1,2` when not exploded), `spaceDelimited`,
   * `pipeDelimited`. A default of `form`, exploded.
   */
  style: z.enum(["form", "spaceDelimited", "pipeDelimited"]).optional(),
  explode: z.boolean().optional(),
  required: z.boolean().default(false),
  /** Human label for the field. Falls back to `name`. */
  label: z.string().max(120).optional(),
  description: z.string().max(300).optional(),
  /** A closed set of accepted values, so the UI can offer a picker. */
  enum: z.array(queryValueSchema).max(50).optional(),
  default: queryValueSchema.optional(),
  example: queryValueSchema.optional(),
  role: z.enum(["id", "search", "rangeStart", "rangeEnd", "sort", "filter"]).optional(),
});

export type ParamDef = z.infer<typeof paramDefSchema>;

/* ── Reads sent with a body ─────────────────────────────────────────── */

/**
 * What a read sends as its body, when it sends one.
 *
 * `json` and `form` templates carry `{{param.x}}` and `{{range.…}}` tokens in
 * their string values, filled when the request is built; a value that is
 * exactly one token takes the parameter's own type, and one that resolves to
 * nothing is left out. `graphql` is a query document and its variables.
 */
export const readBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("json"), template: z.unknown() }),
  z.object({ type: z.literal("form"), template: z.record(z.string(), z.string()) }),
  z.object({
    type: z.literal("graphql"),
    query: z.string().min(1).max(20_000),
    variables: z.record(z.string(), z.unknown()).default({}),
    operationName: z.string().max(120).optional(),
  }),
]);
export type ReadBody = z.infer<typeof readBodySchema>;

/**
 * Why a read that is not a GET is believed to be a read.
 *
 * `get` and `graphql-query` are safe by protocol — a GraphQL document is
 * parsed, and one containing a mutation or subscription is refused. Every
 * other basis is evidence of *intent*, not proof of safety: documentation, a
 * name, a model's reading. A read on one of those is sent only while
 * somebody is looking at it, never warmed in the background, never retried,
 * and journalled. See `dash/RELIABILITY.md`.
 */
export const READ_SAFETY_BASES = [
  "get",
  "graphql-query",
  "spec-declared",
  "docs-inferred",
  "model-inferred",
  "person",
] as const;
export const readSafetySchema = z.object({
  basis: z.enum(READ_SAFETY_BASES),
  /** What the basis rests on, in words: "named searchDeals; returns a list". */
  note: z.string().max(300).optional(),
});
export type ReadSafety = z.infer<typeof readSafetySchema>;

/** Safe by protocol, rather than by anybody's reading of it. */
export const safeByProtocol = (safety: ReadSafety | undefined): boolean =>
  safety === undefined || safety.basis === "get" || safety.basis === "graphql-query";

/**
 * The kinds of operation a GraphQL document declares.
 *
 * Enough of the grammar to answer one question safely — could this document
 * change anything? — without a GraphQL parser: strings and comments are
 * removed, and every top-level definition is read by its first word. A
 * document starting with `{` is a query by the specification's shorthand.
 * A fragment is neither and is ignored.
 */
export const graphqlOperations = (document: string): string[] => {
  const stripped = document
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, "");
  const kinds: string[] = [];
  let depth = 0;
  let index = 0;
  while (index < stripped.length) {
    const char = stripped[index]!;
    if (char === "{") {
      if (depth === 0) kinds.push("query");
      depth++;
      index++;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      index++;
      continue;
    }
    if (depth === 0) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(stripped.slice(index));
      if (word) {
        const kind = word[0];
        if (kind === "query" || kind === "mutation" || kind === "subscription") {
          kinds.push(kind);
          /* Skip to this definition's own brace, so it is not counted twice. */
          const open = stripped.indexOf("{", index);
          if (open < 0) break;
          index = open + 1;
          depth = 1;
          continue;
        }
        if (kind === "fragment") {
          const open = stripped.indexOf("{", index);
          if (open < 0) break;
          index = open + 1;
          depth = 1;
          kinds.push("fragment");
          continue;
        }
        index += kind.length;
        continue;
      }
    }
    index++;
  }
  return kinds.filter((kind) => kind !== "fragment");
};

/** A GraphQL document that can only read: at least one query, and nothing else. */
export const graphqlReadsOnly = (document: string): boolean => {
  const kinds = graphqlOperations(document);
  return kinds.length > 0 && kinds.every((kind) => kind === "query");
};

/**
 * Every `{{param.x}}` token in a path, in the order it appears.
 *
 * Lives here rather than with the connection schema because reading a path's
 * shape is what tells `resource.ts` a collection from a record — and
 * `connection.ts` imports `resource.ts`, so the other direction is a cycle.
 */
export const pathParamNames = (path: string): string[] => [
  ...new Set(
    [...path.matchAll(/\{\{\s*param\.([A-Za-z0-9_]+)[^}]*\}\}/g)].map((match) => match[1]!),
  ),
];

/**
 * FNV-1a. A fingerprint for drift detection, not a security hash.
 *
 * Lives here so the one implementation serves both a response's field set
 * (`inferShape`) and a connection's endpoint set (`opsFingerprint`). Two hashes
 * that drift apart would make "did this change?" answerable two different ways.
 */
export const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
