/**
 * What Dash can connect to, stated once.
 *
 * The importers used to meet an API needing something Dash cannot do — a
 * signed request, an OAuth sign-in, a CSV response — and carry on as if it
 * were not there: an unsupported scheme became "no key needed", a header
 * parameter was dropped, and the connection failed later for a reason nobody
 * was told. This manifest is the one list of what is supported, what is only
 * partly supported and what is not yet, so an importer can name the gap in
 * plain words at the moment it finds it, and `COMPATIBILITY.md` is generated
 * from the same list rather than written beside it.
 *
 * `note` is written for the person connecting an API, not for a developer:
 * what it means for them, never how the code works.
 */

export type CapabilityStatus = "supported" | "partial" | "planned" | "unsupported";

export type CapabilityArea =
  | "transport"
  | "request"
  | "response"
  | "auth"
  | "pagination"
  | "limits"
  | "discovery"
  | "network"
  | "data"
  | "deployment";

export interface Capability {
  readonly id: string;
  readonly area: CapabilityArea;
  readonly name: string;
  readonly status: CapabilityStatus;
  readonly note: string;
}

export const CAPABILITIES = [
  /* ── transport ─────────────────────────────────────────────────────── */
  {
    id: "transport.rest",
    area: "transport",
    name: "REST APIs over HTTPS",
    status: "supported",
    note: "Each connection reads from one address.",
  },
  {
    id: "transport.graphql",
    area: "transport",
    name: "GraphQL APIs",
    status: "partial",
    note: "A GraphQL query can be read, and paged through its variables; one that could change anything is refused. Reads are set up from the API's schema: published by its documentation, or asked of the API itself.",
  },
  {
    id: "transport.mcp",
    area: "transport",
    name: "MCP servers",
    status: "partial",
    note: "An MCP server reached over HTTP is a connection: the tools it marks read-only become endpoints, and so do tools named for reading where it says nothing either way. Any other tool is never called for a board. A server that signs clients in through OAuth's dynamic registration needs a token pasted for now; servers started as a local process are not reached.",
  },
  {
    id: "transport.soap",
    area: "transport",
    name: "SOAP web services",
    status: "partial",
    note: "A SOAP service is set up from its WSDL (1.1, document/literal): each operation named for reading becomes an endpoint that posts its envelope, and the answer is read as XML. A sign-in in the envelope, and RPC-style services, are for connector code.",
  },
  {
    id: "transport.stream",
    area: "transport",
    name: "Streams (server-sent events, WebSocket)",
    status: "partial",
    note: "A stream of server-sent events is read for a window — up to a hundred events or five seconds by default — and the tile says it shows only what arrived in it. WebSocket streams are not read.",
  },
  {
    id: "transport.binary",
    area: "transport",
    name: "Binary protocols (gRPC, Protocol Buffers)",
    status: "unsupported",
    note: "These need a purpose-built connector.",
  },

  /* ── request ───────────────────────────────────────────────────────── */
  {
    id: "request.get",
    area: "request",
    name: "Reads sent with GET",
    status: "supported",
    note: "Every widget reads with GET.",
  },
  {
    id: "request.post-read",
    area: "request",
    name: "Reads sent with POST (search and report endpoints)",
    status: "supported",
    note: "A search or report that needs a request body can drive a widget. Unless the protocol proves it only reads, it is sent only while somebody is looking, never in the background, never retried, and every send is journalled.",
  },
  {
    id: "request.query-params",
    area: "request",
    name: "Query and path parameters",
    status: "supported",
    note: "Single values, filled from a widget's filters, its time range or the record it belongs to.",
  },
  {
    id: "request.header-params",
    area: "request",
    name: "Header parameters",
    status: "supported",
    note: "Read from the specification and sent with each request; a header allowed a single value, such as a version, is sent with it.",
  },
  {
    id: "request.cookie-params",
    area: "request",
    name: "Cookie parameters",
    status: "supported",
    note: "Read from the specification and sent as cookies.",
  },
  {
    id: "request.serialization",
    area: "request",
    name: "List and object parameters",
    status: "partial",
    note: "Lists are written as the specification says (repeated, comma-, space- or bar-separated), and deepObject filters as the parameters they send. Other nested shapes on the query string are not.",
  },
  {
    id: "request.workflow",
    area: "request",
    name: "Multi-step reads (start an export, wait, download)",
    status: "partial",
    note: "A read that takes several requests is done by connector code, which the connection's check writes and proves against the API. One read may take up to a minute, waiting included.",
  },
  {
    id: "request.connector-code",
    area: "request",
    name: "Connector code, for what a connection cannot describe",
    status: "partial",
    note: "The check writes a small program for an API whose sign-in or reading needs one, runs it in a sandbox that can reach only the addresses and use only the credentials it declares, and keeps it only when a read through it returns records. It reads; it cannot make changes yet.",
  },

  /* ── response ──────────────────────────────────────────────────────── */
  {
    id: "response.json",
    area: "response",
    name: "JSON responses",
    status: "supported",
    note: "Records are read from anywhere in the response.",
  },
  {
    id: "response.csv",
    area: "response",
    name: "CSV and TSV responses",
    status: "supported",
    note: "An endpoint that answers with a table of rows is read as records: the first row names the columns.",
  },
  {
    id: "response.xml",
    area: "response",
    name: "XML responses",
    status: "supported",
    note: "An endpoint that answers in XML is read as records: elements and attributes become fields, repeated elements a list, and a SOAP envelope is opened. Requests that must themselves be XML (SOAP calls) are sent by connector code.",
  },
  {
    id: "response.ndjson",
    area: "response",
    name: "Newline-delimited JSON",
    status: "supported",
    note: "An endpoint that answers one record a line is read as records.",
  },
  {
    id: "response.binary",
    area: "response",
    name: "Files and binary responses",
    status: "unsupported",
    note: "Images, PDFs and other files are not read as data.",
  },

  /* ── auth ──────────────────────────────────────────────────────────── */
  {
    id: "auth.none",
    area: "auth",
    name: "Public APIs",
    status: "supported",
    note: "No key is asked for when the specification says none is needed.",
  },
  {
    id: "auth.bearer",
    area: "auth",
    name: "Bearer tokens",
    status: "supported",
    note: "Sent in the Authorization header.",
  },
  {
    id: "auth.header",
    area: "auth",
    name: "API keys in a header",
    status: "supported",
    note: "Any header name, with an optional prefix such as “Token”.",
  },
  {
    id: "auth.query",
    area: "auth",
    name: "API keys in the address",
    status: "supported",
    note: "Sent as a query parameter and hidden wherever the address is shown.",
  },
  {
    id: "auth.basic",
    area: "auth",
    name: "Username and password (HTTP Basic)",
    status: "supported",
    note: "Both halves are kept encrypted.",
  },
  {
    id: "auth.multi-header",
    area: "auth",
    name: "Several keys sent together",
    status: "supported",
    note: "Up to four headers at once.",
  },
  {
    id: "auth.oauth2",
    area: "auth",
    name: "OAuth 2.0",
    status: "supported",
    note: "Signing in with the provider, and renewing tokens before and after they run out, happens by itself. It needs an app registered with the provider, whose client ID and secret are pasted once.",
  },
  {
    id: "auth.oauth2-token",
    area: "auth",
    name: "OAuth 2.0 without a flow Dash can run",
    status: "partial",
    note: "When the documentation gives no sign-in address, or only the implicit or password flow, an access token can be pasted by hand, but the connection stops working when it expires.",
  },
  {
    id: "auth.oidc",
    area: "auth",
    name: "OpenID Connect",
    status: "partial",
    note: "A specification that signs in with OpenID Connect has its provider's discovery document read, where it can be: somebody signs in once with the provider, or an app signs in as itself, and the token is kept and renewed.",
  },
  {
    id: "auth.cookie",
    area: "auth",
    name: "API keys in a cookie",
    status: "supported",
    note: "An API key sent in a cookie, alone or beside keys in headers or the address, is sent where the API wants each.",
  },
  {
    id: "auth.digest",
    area: "auth",
    name: "HTTP Digest",
    status: "supported",
    note: "A username and password answered to the server's challenge, with MD5 or SHA-256; the password itself is never sent.",
  },
  {
    id: "auth.mtls",
    area: "auth",
    name: "Client certificates (mutual TLS)",
    status: "supported",
    note: "The account's client certificate and key, pasted once, are presented to the API's own host and nowhere else, over https only, beside whatever key it also asks for.",
  },
  {
    id: "auth.signing",
    area: "auth",
    name: "Signed requests (AWS Signature, HMAC)",
    status: "partial",
    note: "Connector code signs each request: the server makes the signature with your key, and the code never sees the key. Each API's signing is written from its documentation and proven by a read. AWS Signature Version 4 needs no code: it is built in, signing each request with your secret access key for the region its address or documentation names.",
  },
  {
    id: "auth.token-exchange",
    area: "auth",
    name: "Signing in for a session token",
    status: "partial",
    note: "Client credentials are supported directly. Any other login for a session token is done by connector code: the server sends the login and keeps the token, and the code never sees either.",
  },

  /* ── pagination ────────────────────────────────────────────────────── */
  {
    id: "pagination.cursor",
    area: "pagination",
    name: "Cursor pages",
    status: "supported",
    note: "The next cursor is read from each response.",
  },
  {
    id: "pagination.offset",
    area: "pagination",
    name: "Offset pages",
    status: "supported",
    note: "Reading stops at the first short page.",
  },
  {
    id: "pagination.page",
    area: "pagination",
    name: "Numbered pages",
    status: "supported",
    note: "Reading stops at the first short page.",
  },
  {
    id: "pagination.link-header",
    area: "pagination",
    name: "Link-header pages",
    status: "supported",
    note: "The next page's address is read from the response headers.",
  },
  {
    id: "pagination.next-url",
    area: "pagination",
    name: "Next-page addresses in the answer",
    status: "supported",
    note: "The next page's address is read from each answer (`links.next`, `_links.next.href`, `@odata.nextLink`) and followed on the API's own address until an answer gives none.",
  },
  {
    id: "pagination.body",
    area: "pagination",
    name: "Page tokens sent in a request body",
    status: "supported",
    note: "A page token or number can travel in a request body or in GraphQL variables.",
  },
  {
    id: "pagination.confirmation",
    area: "pagination",
    name: "Pagination read from documentation",
    status: "supported",
    note: "Confirmed by checking the connection: a rule is kept only when its second page returns new records. Until then one page is read, and the tile says so.",
  },

  /* ── limits ────────────────────────────────────────────────────────── */
  {
    id: "limits.pages",
    area: "limits",
    name: "Pages per read",
    status: "partial",
    note: "A tile reads up to 50 pages at once, 5 unless set, and says what it left out. A read that stops at that limit is carried on in the background from where it stopped, up to 2,000 pages, through a restart, and the tile is answered whole when it reaches the end.",
  },
  {
    id: "limits.fan-out",
    area: "limits",
    name: "Records expanded per widget",
    status: "partial",
    note: "A widget reading each record's related records reads the first 25 at once and the rest in the background, up to 500, through a restart, and says what it has not read yet. One record the key may not read is counted and the rest are read.",
  },

  /* ── discovery ─────────────────────────────────────────────────────── */
  {
    id: "discovery.openapi",
    area: "discovery",
    name: "OpenAPI 3 and Swagger 2 specifications",
    status: "supported",
    note: "Endpoints, their parameters, the fields they return and how to sign in are read from the specification.",
  },
  {
    id: "discovery.external-ref",
    area: "discovery",
    name: "Specifications split across several files",
    status: "partial",
    note: "References to other files on the specification's own site are followed and put back together, up to 40 files. A reference to another organisation's site is not followed, and is named.",
  },
  {
    id: "discovery.embedded",
    area: "discovery",
    name: "Specifications embedded in a documentation page",
    status: "supported",
    note: "Found in the page itself when no separate file is published.",
  },
  {
    id: "discovery.index",
    area: "discovery",
    name: "Documentation indexes (llms.txt)",
    status: "supported",
    note: "Followed to the specifications they list; reading every page is offered separately.",
  },
  {
    id: "discovery.prose",
    area: "discovery",
    name: "Documentation written as prose",
    status: "partial",
    note: "An AI model reads the page and proposes a few endpoints without their parameters. Everything it proposes is marked as a guess until a request proves it.",
  },
  {
    id: "discovery.rendered",
    area: "discovery",
    name: "Documentation that only appears in a browser",
    status: "supported",
    note: "Drawn by Playwright's own Chromium, headless, with every request the page makes answered through the server's guarded reader: public addresses only, reads only, no downloads, pop-ups or WebSockets, bounded in requests, bytes and seconds. A specification the page fetched to draw itself, or one it holds or links to, is imported exactly; otherwise its prose is read. A hosted build has Chromium in its image. The open-source build asks once before downloading it (about 150 MB) and remembers the answer; until then such a page is said to need it.",
  },
  {
    id: "discovery.graphql",
    area: "discovery",
    name: "GraphQL schemas",
    status: "partial",
    note: "A schema published as SDL, in the documentation or a file it links to, or asked of the API (introspection, a type at a time where queries are limited in depth), becomes one read per list: its records' fields selected, paged by cursor, page or offset as the schema says. A list that needs an input is kept: the input is settled from another list's records, or read for each of them when the question is about all of them.",
  },
  {
    id: "discovery.wsdl",
    area: "discovery",
    name: "WSDL service descriptions",
    status: "partial",
    note: "A WSDL (1.1, document/literal) sets up one endpoint per operation named for reading. RPC-style services, and a sign-in in the envelope, are for connector code.",
  },

  /* ── network ───────────────────────────────────────────────────────── */
  {
    id: "network.public",
    area: "network",
    name: "APIs on the public internet",
    status: "supported",
    note: "Every request is checked to go only to the connection's own address.",
  },
  {
    id: "network.private",
    area: "network",
    name: "APIs on a private or internal network",
    status: "supported",
    note: "Reached only when the server's operator allows the address (DASH_PRIVATE_EGRESS) and the connection says it is on a private network; the address checked is the one connected to. Cloud metadata addresses are never reached. A hosted build reaches a customer's network through an agent they run, as the server's transport.",
  },

  /* ── data ──────────────────────────────────────────────────────────── */
  {
    id: "data.history",
    area: "data",
    name: "History the API does not keep",
    status: "partial",
    note: "What each number tile showed is kept day by day, for 400 days, from the day the board was first looked after; its line says when its history starts. Nothing earlier is claimed, and nothing but number tiles is kept.",
  },
  {
    id: "data.writes",
    area: "data",
    name: "Changing records",
    status: "supported",
    note: "Every change is reviewed before it is sent, and sent once.",
  },

  /* ── deployment ────────────────────────────────────────────────────── */
  {
    id: "deployment.local",
    area: "deployment",
    name: "One person on their own machine",
    status: "supported",
    note: "The server listens only on this computer.",
  },
  {
    id: "deployment.shared",
    area: "deployment",
    name: "Several people sharing one server",
    status: "partial",
    note: "Sign-in through an OpenID Connect provider; members with roles and grants scoped to a connection or a record type, asked on every change and every read. With DASH_WORKSPACES=many, one server holds several workspaces, each with its own connections, boards, keys, chats, jobs and evidence. Tested in process, not yet against a live identity provider. The open-source build has one owner and no sign-in, on this machine only.",
  },
] as const satisfies readonly Capability[];

export type CapabilityId = (typeof CAPABILITIES)[number]["id"];

const BY_ID = new Map<string, Capability>(CAPABILITIES.map((one) => [one.id, one]));

export const capability = (id: CapabilityId): Capability => BY_ID.get(id)!;

/**
 * What an importer says when an API needs something Dash cannot fully do.
 *
 * `subject` names what needs it — `The "sigv4" sign-in scheme`, `3 endpoints`
 * — so the sentence points at the part of the API it is about.
 */
export const capabilityNote = (id: CapabilityId, subject = "This API"): string => {
  const found = capability(id);
  const verdict =
    found.status === "partial"
      ? "is only partly supported"
      : found.status === "supported"
        ? "is supported"
        : "is not supported yet";
  // "Signed requests" reads mid-sentence as "signed requests"; "OAuth", "OpenID" and "CSV" stay as they are.
  const name = /^[A-Z][a-z]+(\s|$)/.test(found.name)
    ? `${found.name.charAt(0).toLowerCase()}${found.name.slice(1)}`
    : found.name;
  // "3 endpoints use", "This API uses".
  const verb = /^\d+ \w+s$/.test(subject) ? "use" : "uses";
  return `${subject} ${verb} ${name}, which ${verdict}. ${found.note}`;
};

const AREA_TITLES: Record<CapabilityArea, string> = {
  transport: "Kinds of API",
  request: "Requests",
  response: "Responses",
  auth: "Signing in",
  pagination: "Pages",
  limits: "Limits",
  discovery: "Reading documentation",
  network: "Networks",
  data: "Data",
  deployment: "Running it",
};

const STATUS_LABEL: Record<CapabilityStatus, string> = {
  supported: "Supported",
  partial: "Partly",
  planned: "Not yet",
  unsupported: "No",
};

/** `COMPATIBILITY.md`, generated — a test fails when the file drifts from this. */
export const compatibilityMarkdown = (): string => {
  const lines: string[] = [
    "# What Dash can connect to",
    "",
    "<!-- Generated from packages/spec/src/capabilities.ts. Edit that file, then run",
    "     UPDATE_COMPATIBILITY=1 pnpm vitest run dash/packages/spec/src/capabilities.test.ts -->",
    "",
    "This is the boundary as the code stands, not a measured success rate. When an API needs something marked",
    "*Partly* or *Not yet*, the connection says so in the words below at the moment it finds out.",
    "",
  ];
  for (const area of Object.keys(AREA_TITLES) as CapabilityArea[]) {
    const rows = CAPABILITIES.filter((one) => one.area === area);
    if (rows.length === 0) continue;
    lines.push(`## ${AREA_TITLES[area]}`, "", "| | Status | What it means |", "|---|---|---|");
    for (const row of rows) {
      lines.push(`| ${row.name} | ${STATUS_LABEL[row.status]} | ${row.note} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
};
