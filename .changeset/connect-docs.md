---
"@freebirdai/connect": minor
"@freebirdai/connect-spec": patch
"@freebirdai/connect-server": patch
"@freebirdai/connect-postgres": patch
"@freebirdai/connect-sandbox": patch
"@freebirdai/connect-browser": patch
---

Make Connect usable on its own: a README with a five-minute quickstart, an `AGENTS.md` integration guide, a docs-site section, and two runnable examples (`examples/connect-node`, `examples/connect-express`). After a check, the engine now describes the API's record types by itself when a model is configured, so `read({ record })` works without a host wiring it up.
