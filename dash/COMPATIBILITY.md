# What Dash can connect to

<!-- Generated from packages/spec/src/capabilities.ts. Edit that file, then run
     UPDATE_COMPATIBILITY=1 pnpm vitest run dash/packages/spec/src/capabilities.test.ts -->

This is the boundary as the code stands, not a measured success rate. When an API needs something marked
*Partly* or *Not yet*, the connection says so in the words below at the moment it finds out.

## Kinds of API

| | Status | What it means |
|---|---|---|
| REST APIs over HTTPS | Supported | Each connection reads from one address. |
| GraphQL APIs | Partly | A GraphQL query can be read, and paged through its variables; one that could change anything is refused. Setting one up from the API's schema is not done yet. |
| MCP servers | Not yet | The server does not connect to MCP servers yet. |
| SOAP web services | Not yet | SOAP requests are XML sent with POST, and neither is read yet. |
| Streams (server-sent events, WebSocket) | Not yet | Only requests that answer once can be read. |
| Binary protocols (gRPC, Protocol Buffers) | No | These need a purpose-built connector. |

## Requests

| | Status | What it means |
|---|---|---|
| Reads sent with GET | Supported | Every widget reads with GET. |
| Reads sent with POST (search and report endpoints) | Supported | A search or report that needs a request body can drive a widget. Unless the protocol proves it only reads, it is sent only while somebody is looking, never in the background, never retried, and every send is journalled. |
| Query and path parameters | Supported | Single values, filled from a widget's filters, its time range or the record it belongs to. |
| Header parameters | Supported | Read from the specification and sent with each request; a header allowed a single value, such as a version, is sent with it. |
| Cookie parameters | Supported | Read from the specification and sent as cookies. |
| List and object parameters | Partly | Lists are written as the specification says (repeated, comma-, space- or bar-separated), and deepObject filters as the parameters they send. Other nested shapes on the query string are not. |
| Multi-step reads (start an export, wait, download) | Partly | A read that takes several requests is done by connector code, which the connection's check writes and proves against the API. One read may take up to a minute, waiting included. |
| Connector code, for what a connection cannot describe | Partly | The check writes a small program for an API whose sign-in or reading needs one, runs it in a sandbox that can reach only the addresses and use only the credentials it declares, and keeps it only when a read through it returns records. It reads; it cannot make changes yet. |

## Responses

| | Status | What it means |
|---|---|---|
| JSON responses | Supported | Records are read from anywhere in the response. |
| CSV and TSV responses | Partly | Read through connector code, which turns the file into records. An endpoint that answers with a spreadsheet file is not read without it. |
| XML responses | Not yet | An endpoint answering in XML cannot be read yet. |
| Newline-delimited JSON | Partly | Read through connector code, one record per line. An endpoint that answers this way is not read without it. |
| Files and binary responses | No | Images, PDFs and other files are not read as data. |

## Signing in

| | Status | What it means |
|---|---|---|
| Public APIs | Supported | No key is asked for when the specification says none is needed. |
| Bearer tokens | Supported | Sent in the Authorization header. |
| API keys in a header | Supported | Any header name, with an optional prefix such as “Token”. |
| API keys in the address | Supported | Sent as a query parameter and hidden wherever the address is shown. |
| Username and password (HTTP Basic) | Supported | Both halves are kept encrypted. |
| Several keys sent together | Supported | Up to four headers at once. |
| OAuth 2.0 | Supported | Signing in with the provider, and renewing tokens before and after they run out, happens by itself. It needs an app registered with the provider, whose client ID and secret are pasted once. |
| OAuth 2.0 without a flow Dash can run | Partly | When the documentation gives no sign-in address, or only the implicit or password flow, an access token can be pasted by hand, but the connection stops working when it expires. |
| OpenID Connect | Not yet | Signing in through an identity provider is not supported yet. |
| API keys in a cookie | Not yet | A key the API expects as a cookie cannot be sent yet. |
| HTTP Digest | Not yet | Digest sign-in is not supported yet. |
| Client certificates (mutual TLS) | Not yet | A certificate cannot be presented with requests yet. |
| Signed requests (AWS Signature, HMAC) | Partly | Connector code signs each request: the server makes the signature with your key, and the code never sees the key. Each API's signing is written from its documentation and proven by a read. |
| Signing in for a session token | Partly | Client credentials are supported directly. Any other login for a session token is done by connector code: the server sends the login and keeps the token, and the code never sees either. |

## Pages

| | Status | What it means |
|---|---|---|
| Cursor pages | Supported | The next cursor is read from each response. |
| Offset pages | Supported | Reading stops at the first short page. |
| Numbered pages | Supported | Reading stops at the first short page. |
| Link-header pages | Supported | The next page's address is read from the response headers. |
| Page tokens sent in a request body | Supported | A page token or number can travel in a request body or in GraphQL variables. |
| Pagination read from documentation | Supported | Confirmed by checking the connection: a rule is kept only when its second page returns new records. Until then one page is read, and the tile says so. |

## Limits

| | Status | What it means |
|---|---|---|
| Pages per read | Partly | Up to 50 pages per read, 5 unless set. A read that stops early says so on the tile: what is shown excludes the rest. |
| Records expanded per widget | Partly | A widget reading each record's related records reads at most 25 records' worth, and says so when there were more. |

## Reading documentation

| | Status | What it means |
|---|---|---|
| OpenAPI 3 and Swagger 2 specifications | Supported | Endpoints, their parameters, the fields they return and how to sign in are read from the specification. |
| Specifications split across several files | Not yet | References to other files are not followed, so the parts described there are missing. |
| Specifications embedded in a documentation page | Supported | Found in the page itself when no separate file is published. |
| Documentation indexes (llms.txt) | Supported | Followed to the specifications they list; reading every page is offered separately. |
| Documentation written as prose | Partly | An AI model reads the page and proposes a few endpoints without their parameters. Everything it proposes is marked as a guess until a request proves it. |
| Documentation that only appears in a browser | Not yet | A page that is built by scripts shows nothing to read. |
| GraphQL schemas | Not yet | Depends on GraphQL support. |
| WSDL service descriptions | Not yet | Depends on SOAP support. |

## Networks

| | Status | What it means |
|---|---|---|
| APIs on the public internet | Supported | Every request is checked to go only to the connection's own address. |
| APIs on a private or internal network | Not yet | Private and internal addresses are refused, whatever the documentation says. |

## Data

| | Status | What it means |
|---|---|---|
| History the API does not keep | Not yet | Only what the API returns now can be shown; past values of something the API overwrites are not kept. |
| Changing records | Supported | Every change is reviewed before it is sent, and sent once. |

## Running it

| | Status | What it means |
|---|---|---|
| One person on their own machine | Supported | The server listens only on this computer. |
| Several people sharing one server | Not yet | Sign-in, members and permissions are not built yet. |
