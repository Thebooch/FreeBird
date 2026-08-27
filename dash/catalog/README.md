# Dialect catalog

One file per API, describing **how that vendor does things** — auth style,
pagination, where rows live, how dates are filtered. Declared once here, and
every endpoint on that API inherits it.

This is the seed tier. A running instance keeps its own overlay in
`.dash/catalog/` for dialects derived locally from an OpenAPI spec or from
documentation; those win over anything here, so a stale seed can be corrected
without waiting for a release. A good local dialect is exactly what should come
back here as a pull request.

## Adding one

Copy the closest existing file and change the four things that matter:

```jsonc
{
  "id": "stripe",                       // lowercase, becomes the filename
  "title": "Stripe",
  "baseUrl": "https://api.stripe.com",
  "dialect": {
    "auth": { "type": "bearer", "keyRef": "stripe-key" },
    "pagination": {                     // none | cursor | offset | page | link-header
      "kind": "cursor",
      "cursorPath": "$.data[last].id",  // `[last]` exists for exactly this case
      "param": "starting_after",
      "hasMorePath": "$.has_more"
    },
    "rowsPath": "$.data",               // where the row list lives
    "timeFilter": { "param": "created[gte]", "format": "unix" }
  },
  "ops": [
    { "id": "charges", "title": "Charges", "path": "/v1/charges" }
  ]
}
```

Endpoints are one line each once the dialect is right. `archetype` defaults to
`list`; use `summary` for a single object of scalars and `timeseries` for data
the API has already bucketed.

## The rules

- **`verified` is not yours to set.** It flips to true only when a real request
  against a real key returns usable rows. A dialect written from documentation
  is a hypothesis until then.
- **Never commit a key.** `keyRef` names a vault entry; the secret lives in the
  encrypted vault and never in this directory.
- **Free/public endpoints make the best `validateOpId`** — onboarding should be
  able to prove a connection works without burning a paid quota.
- **Don't guess pagination.** A wrong strategy does not error; it silently
  returns page one and a chart that is quietly incomplete. Leave it `none` if
  you are unsure, and let someone verify it against the live API.
