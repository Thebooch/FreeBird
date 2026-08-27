# FreeBird Dash

A declarative binding runtime and a polished React component library for building dashboards over any API.

The charts aren't the hard part — LLMs emit Recharts fine. What hand-built dashboards are missing is everything *around* the charts: loading, empty, error and stale states; consistent number formatting; a time-range filter every widget actually respects; responsive layout; a refresh policy; and a data pipeline that isn't fifteen bespoke `.map().filter().reduce()` chains scattered across components.

Dash gives you all of that from a JSON spec.

```jsonc
{
  "id": "revenue_trend",
  "component": "timeseries",
  "source": { "connection": "stripe", "op": "charges.list" },
  "pipeline": [
    { "op": "extract", "path": "$.data[*]" },
    { "op": "coerce", "fields": { "created": "unix_s->datetime", "amount": "int->money:cents" } },
    { "op": "filter", "where": "status == 'succeeded'" },
    { "op": "group", "by": [{ "field": "created", "bucket": "{{range.grain}}" }],
                     "agg": { "revenue": "sum(amount)" } }
  ],
  "roles": { "time": "created", "value": "revenue" },
  "format": { "revenue": { "semantic": "currency", "currency": "USD" } }
}
```

## Running it locally

Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env
```

Then start the API and the web app together:

```bash
pnpm dev
```

Open **http://localhost:5400** — Vite binds IPv6 here, so `127.0.0.1:5400` will not answer. The API is on `:4600`; the web dev server proxies to it.

Use pnpm, not npm — internal packages are linked with `workspace:*`, which npm cannot resolve.

Other dev scripts: `pnpm dev:packages` rebuilds the libraries in watch mode, and `pnpm dev:all` runs those alongside the apps. You only need those when editing something under `packages/`.

Everything works with an empty `.env`: you can describe an API by hand, import an OpenAPI spec, or use a catalog entry, all without a model. Adding `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) additionally lets Dash read human documentation and search for an API by name, and enables the authoring agent. The server prints which of those are active on startup. Every option is documented in [.env.example](.env.example).

**Each AI action runs on the model that suits it**, and the defaults need no configuration. Setting an API up — reading its docs, mapping it, building a widget — is judgement, and runs on the capable model. Using what you built — chat, naming fields, matching a phrase to real values — is reading, and runs on the cheap one. Setup is rare and one-off; use is constant, which is why the split is worth having. The picker in the top bar shows every action, what runs it, and what it has cost so far.

That routing was measured rather than assumed, and `pnpm eval:models` is how. It replays recorded requests against a list of models and prints a pass/cost table — it spends model tokens and makes **zero** calls against your API, so it is safe to run against a rate-limited account. It is not a test and never runs in CI: it costs money and its answers are not deterministic.

Two things worth knowing before you file a bug:

- **Dashboards and connections are read from the working directory**, so `pnpm --filter` puts them in `apps/server/`. Launching the server another way (`tsx apps/server/src/index.ts` from the repo root, say) reads a different directory and looks like your connections vanished. Set `DASH_ROOT` to pin it.
- **`apps/web` imports the packages' built output**, so after editing anything under `packages/` you need `pnpm build` or the browser keeps showing the old code.

## Principles

**The LLM runs at configuration time, never at render time.** The authoring agent reads sample payloads and emits a deterministic, versioned artifact. That artifact is compiled once and executed by boring code forever after. An LLM in the request path means nondeterministic dashboards, unbounded cost, and no way to debug why a number changed.

**Expressions are safe by construction.** No `eval`, no `new Function`, no third-party path library. The agent writes these expressions and untrusted third-party API data flows through them.

**Every widget can show its work.** The inspector shows the endpoint, the resolved params, row counts at each pipeline step, and the raw payload. A dashboard that's subtly wrong is worse than no dashboard, because people make decisions on it.

## Status

Pre-alpha. Under active development — see `AGENTS.md` for the build order.

### What v1 does not do

- **No history the API doesn't have.** Most product APIs hand you a list of objects with no aggregation primitives and no history — a follower-count endpoint returns today's number. Dash shows the current window. Trend lines over data the provider doesn't retain require snapshotting on a schedule, which is an ETL product, not this one.
- **No cross-source joins.** Combining Stripe customers with HubSpot contacts requires entity resolution. Each widget reads from one source.
- **No writes.** Read-only against every connected API.

## License

MIT © Thebooch
