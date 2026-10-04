# What Dash can connect to

<!-- Generated from packages/spec/src/capabilities.ts. Edit that file, then run
     UPDATE_COMPATIBILITY=1 pnpm vitest run dash/packages/spec/src/capabilities.test.ts -->

This is the boundary as the code stands, not a measured success rate. When an API needs something marked
*Partly* or *Not yet*, the connection says so in the words below at the moment it finds out.

## Kinds of API

| | Status | What it means |
|---|---|---|
| REST APIs over HTTPS | Supported | Each connection reads from one address. |
| GraphQL APIs | Partly | A GraphQL query can be read, and paged through its variables; one that could change anything is refused. Reads are set up from the API's schema: published by its documentation, or asked of the API itself. |
| MCP servers | Partly | An MCP server reached over HTTP is a connection: the tools it marks read-only become endpoints, and so do tools named for reading where it says nothing either way. Any other tool is never called for a board. A server that signs clients in through OAuth's dynamic registration needs a token pasted for now; servers started as a local process are not reached. |
| SOAP web services | Partly | A SOAP service is set up from its WSDL (1.1, document/literal): each operation named for reading becomes an endpoint that posts its envelope, and the answer is read as XML. A sign-in in the envelope, and RPC-style services, are for connector code. |
| Streams (server-sent events, WebSocket) | Partly | A stream of server-sent events is read for a window — up to a hundred events or five seconds by default — and the tile says it shows only what arrived in it. WebSocket streams are not read. |
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
| CSV and TSV responses | Supported | An endpoint that answers with a table of rows is read as records: the first row names the columns. |
| XML responses | Supported | An endpoint that answers in XML is read as records: elements and attributes become fields, repeated elements a list, and a SOAP envelope is opened. Requests that must themselves be XML (SOAP calls) are sent by connector code. |
| Newline-delimited JSON | Supported | An endpoint that answers one record a line is read as records. |
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
| OpenID Connect | Partly | A specification that signs in with OpenID Connect has its provider's discovery document read, where it can be: somebody signs in once with the provider, or an app signs in as itself, and the token is kept and renewed. |
| API keys in a cookie | Supported | An API key sent in a cookie, alone or beside keys in headers or the address, is sent where the API wants each. |
| HTTP Digest | Supported | A username and password answered to the server's challenge, with MD5 or SHA-256; the password itself is never sent. |
| Client certificates (mutual TLS) | Supported | The account's client certificate and key, pasted once, are presented to the API's own host and nowhere else, over https only, beside whatever key it also asks for. |
| Signed requests (AWS Signature, HMAC) | Partly | Connector code signs each request: the server makes the signature with your key, and the code never sees the key. Each API's signing is written from its documentation and proven by a read. AWS Signature Version 4 needs no code: it is built in, signing each request with your secret access key for the region its address or documentation names. |
| Signing in for a session token | Partly | Client credentials are supported directly. Any other login for a session token is done by connector code: the server sends the login and keeps the token, and the code never sees either. |

## Pages

| | Status | What it means |
|---|---|---|
| Cursor pages | Supported | The next cursor is read from each response. |
| Offset pages | Supported | Reading stops at the first short page. |
| Numbered pages | Supported | Reading stops at the first short page. |
| Link-header pages | Supported | The next page's address is read from the response headers. |
| Next-page addresses in the answer | Supported | The next page's address is read from each answer (`links.next`, `_links.next.href`, `@odata.nextLink`) and followed on the API's own address until an answer gives none. |
| Page tokens sent in a request body | Supported | A page token or number can travel in a request body or in GraphQL variables. |
| Pagination read from documentation | Supported | Confirmed by checking the connection: a rule is kept only when its second page returns new records. Until then one page is read, and the tile says so. |

## Limits

| | Status | What it means |
|---|---|---|
| Pages per read | Partly | A tile reads up to 50 pages at once, 5 unless set, and says what it left out. A read that stops at that limit is carried on in the background from where it stopped, up to 2,000 pages, through a restart, and the tile is answered whole when it reaches the end. |
| Records expanded per widget | Partly | A widget reading each record's related records reads the first 25 at once and the rest in the background, up to 500, through a restart, and says what it has not read yet. One record the key may not read is counted and the rest are read. |

## Reading documentation

| | Status | What it means |
|---|---|---|
| OpenAPI 3 and Swagger 2 specifications | Supported | Endpoints, their parameters, the fields they return and how to sign in are read from the specification. |
| Specifications split across several files | Partly | References to other files on the specification's own site are followed and put back together, up to 40 files. A reference to another organisation's site is not followed, and is named. |
| Specifications embedded in a documentation page | Supported | Found in the page itself when no separate file is published. |
| Documentation indexes (llms.txt) | Supported | Followed to the specifications they list; reading every page is offered separately. |
| Documentation written as prose | Partly | An AI model reads the page and proposes a few endpoints without their parameters. Everything it proposes is marked as a guess until a request proves it. |
| Documentation that only appears in a browser | Supported | Drawn by Playwright's own Chromium, headless, with every request the page makes answered through the server's guarded reader: public addresses only, reads only, no downloads, pop-ups or WebSockets, bounded in requests, bytes and seconds. A specification the page fetched to draw itself, or one it holds or links to, is imported exactly; otherwise its prose is read. A hosted build has Chromium in its image. The open-source build asks once before downloading it (about 150 MB) and remembers the answer; until then such a page is said to need it. |
| GraphQL schemas | Partly | A schema published as SDL, in the documentation or a file it links to, or asked of the API (introspection, a type at a time where queries are limited in depth), becomes one read per list: its records' fields selected, paged by cursor, page or offset as the schema says. A list that needs an input is kept: the input is settled from another list's records, or read for each of them when the question is about all of them. |
| WSDL service descriptions | Partly | A WSDL (1.1, document/literal) sets up one endpoint per operation named for reading. RPC-style services, and a sign-in in the envelope, are for connector code. |

## Networks

| | Status | What it means |
|---|---|---|
| APIs on the public internet | Supported | Every request is checked to go only to the connection's own address. |
| APIs on a private or internal network | Supported | Reached only when the server's operator allows the address (DASH_PRIVATE_EGRESS) and the connection says it is on a private network; the address checked is the one connected to. Cloud metadata addresses are never reached. A hosted build reaches a customer's network through an agent they run, as the server's transport. |

## Data

| | Status | What it means |
|---|---|---|
| History the API does not keep | Partly | What each number tile showed is kept day by day, for 400 days, from the day the board was first looked after; its line says when its history starts. Nothing earlier is claimed, and nothing but number tiles is kept. |
| Changing records | Supported | Every change is reviewed before it is sent, and sent once. |

## Running it

| | Status | What it means |
|---|---|---|
| One person on their own machine | Supported | The server listens only on this computer. |
| Several people sharing one server | Partly | Sign-in through an OpenID Connect provider; members with roles and grants scoped to a connection or a record type, asked on every change and every read. With DASH_WORKSPACES=many, one server holds several workspaces, each with its own connections, boards, keys, chats, jobs and evidence. Tested in process, not yet against a live identity provider. The open-source build has one owner and no sign-in, on this machine only. |
