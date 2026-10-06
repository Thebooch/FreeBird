---
"@freebirdai/connect": minor
"@freebirdai/connect-server": minor
"@freebirdai/connect-browser": patch
---

Finish moving the integration routes out of Dash. `connect-server`'s Fastify entry now also serves a connection's routes (`connectionRoutes`: listing, saving, the catalog, adding from the catalog, address, endpoints, record types, references, checks, enumeration, rhythm), discovery (`discoverRoutes`), keys (`keyRoutes`) and reviewed changes (`writeRoutes`), each taking an engine and a host's own hooks. The engine gains enumeration, field observation, the write-endpoint reader and the connection view the routes serve. `RendererStatus` and `RendererSetup` move into the engine core; `connect-browser` re-exports `RendererStatus`. The benchmark's mock APIs become the engine's test bed in a private `connect/packages/bench`.
