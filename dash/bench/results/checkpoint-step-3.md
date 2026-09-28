# Checkpoint: end of plan step 3 (reads with POST, parameters, OAuth)

Recorded before anything was changed in response to it. See `PROTOCOL.md`.

## Runs

| Run | Integrator | Split | Scenarios | Task success | Incomplete, silently |
|---|---|---|---|---|---|
| `2026-09-28-dev-agent` (after step 3) | agent | dev (11 providers) | 13 | 13 | 0 |
| `2026-09-28-heldout-agent-end-of-step-3` | agent | **held-out** | 5 | **4** | 0 |

All runs used scripted endpoint choices, and no model call was made in any of them.

## The held-out providers written for this step

Both were written on 2026-09-28, **before any of step 3 was built**, and had not been run until this checkpoint.

- **Quotient.** OAuth client credentials, with tokens that stop working after six requests although they claim an hour. Records are available only through a POST search, with the cursor in the body.
  - The loop imported the search as a read on the documentation's evidence (`docs-inferred`).
  - It obtained a token by itself.
  - Its probe found the cursor at `paging.next.after`.
  - It renewed the token part-way through reads without restarting them.
  - It read 230 of 230 records, and the total matched the answer key.
- **Ledgerline.** OAuth sign-in with PKCE on a separate sign-in host, refresh tokens that rotate, a deepObject filter, and the total in an `X-Total-Count` header.
  - The scripted person signed in once, counted as consent.
  - The loop read 380 of 380 records, and the count matched.

## Failures, by cause

| Provider | Stage | Missing capability |
|---|---|---|
| vaultbank | integrate | `auth.signing`, `request.workflow`, `response.csv`: plan step 4 |

## What the numbers are, and are not

- 4 of 5 on the held-out set says the loop and the step 3 capabilities work on patterns written without seeing the implementation. The set is small and synthetic, so it is a baseline, not a rate.
- The dev set (13 of 13) was tuned against.
- **Consent is counted, not hidden.** Ledgerline's sign-in is one consent intervention; the protocol allows it and reports it.

## Defects found while building this step (not from the held-out run)

- **An endpoint's documented default for a paging parameter conflicted with every paged request.** Fixed in step 2.
- **A token running out part-way through a multi-page read failed the whole read, and retrying from page one could never finish** when tokens ran out faster than the pages. Reads now renew the token and read the refused page again (`FetchContext.renew`).
- **Header parameters with a documented default were counted as missing inputs**, which hid the endpoint from the check.
- **The adapters package was not rebuilt after the OAuth change**, so a server ran the old build, which sent no token at all. This is the standing gotcha: rebuild before exercising a change.

## Population

Unchanged.
