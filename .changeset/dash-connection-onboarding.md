---
"@freebirdai/dash-spec": minor
"@freebirdai/dash-agent": minor
"@freebirdai/dash-adapters": minor
"@freebirdai/dash-react": minor
"@freebirdai/dash-server": minor
"@freebirdai/dash-web": minor
---

Connection onboarding: a new connection ends by asking what somebody wants from it and building it.
The API behind it is prepared once for everybody who connects it — what the software is, the parts it
divides into, a starter set of widget briefs per part, and how often each kind of record arrives — one
step per request, each written as it lands, so preparation resumes wherever it stopped. The person then
chooses parts and one tab or a tab each, previews the boards with every widget tried against their account
(a refused widget is left off with its reason; one that could not be tried because of a rate limit is
kept), and creates exactly what was previewed. Setup is a resumable state on the connection
(`pending → choosing → preview → creating → complete`, or `skipped`); an interrupted create finishes the
same boards without overwriting any it already wrote. Existing connections reach it from their
**Dashboards** button, which also makes another set.

The shared half stores briefs, never widgets, and a fingerprint of the API reading it was made against,
so a re-described API is prepared again rather than served stale. Starter composition refuses widgets
whose endpoints need inputs a board cannot supply, and both model passes retry once with the reasons they
were refused.

Keeping boards fresh: a board being looked at reads the server's cache and never calls the API; the
keeper refreshes, on each endpoint's cadence, exactly the requests boards made — including changed filters,
picked ranges and path parameters — and warms new boards before they are opened. It reads refusals behind
cached copies (a 401 or 403 stops a target until the connection's key changes; a 429 pauses the connection
until the API allows it), and a changed cadence applies at the next tick. Polls re-read the server rather
than the API, and staleness is labelled against the endpoint's cadence. The cache key no longer carries the
time range for endpoints that do not read it, and 304 responses are no longer treated as redirects.

Catalog, connection, dashboard and cadence files are written atomically.
