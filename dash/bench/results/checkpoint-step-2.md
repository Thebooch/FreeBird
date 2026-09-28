# Checkpoint: end of plan step 2 (the integration loop)

Recorded before anything was changed in response to it. See `PROTOCOL.md`.

## Runs

| Run | Integrator | Split | Scenarios | Task success | Incomplete, silently |
|---|---|---|---|---|---|
| `2026-09-27-dev-baseline` | baseline (step 1) | dev (6 providers) | 8 | 3 | 0 |
| `2026-09-28-dev-baseline` | baseline | dev (8 providers) | 10 | 3 | 0 |
| `2026-09-28-dev-agent` | agent | dev (8 providers) | 10 | 10 | 0 |
| `2026-09-28-heldout-agent-end-of-step-2` | agent | **held-out** | 3 | **2** | 0 |

Every run used scripted endpoint choices. These measure getting a chosen endpoint to read completely and correctly with nobody editing anything; they do not measure anybody's judgment in choosing it. See PROTOCOL.md.

## What the numbers are, and are not

- **The dev set is tuned against.** The repair strategies were written knowing its patterns: a wrong address named in the docs, a misnamed sign-in header, an undocumented required header, a wrong cursor path, offset and numbered pages. 10 of 10 there shows the strategies do what they were written to do. It is not evidence about unseen APIs.
- **The held-out set is the first unseen measurement.** It is small (3 providers) and synthetic, so it establishes a baseline, not a rate.
  - **Stockroom:** Swagger 2, Link-header pages, Basic with an email and a token. Read 260 of 260 and the answer was correct. The probe found the Link-header rule unaided.
  - **Helpline:** key in the query string, numbered pages with a stated total, unix timestamps. Read 415 of 415 and the answer was correct.
  - **Vaultbank:** HMAC-signed requests, with data only through an export that downloads as CSV. Blocked, as expected: neither signing nor multi-step reads can be expressed yet. They are plan step 4, where this provider is the unfamiliar test.

## Failures, by cause

| Provider | Stage | Missing capability | Notes |
|---|---|---|---|
| vaultbank | integrate | `auth.signing`, `request.workflow`, `response.csv` | The importer already named the signing gap at import. |

## Defects the held-out run exposed (not tuning)

1. **A misleading blocked reason.** Vaultbank's reason read "The API refused the request." In fact nothing was sent: the connection had no sign-in it could use, and the adapter refused to send before any request left. It should say the sign-in is not supported, in the manifest's words. This changes no outcome; the provider stays blocked until step 4.
2. **A technical intervention counted for credentials.** A sign-in the importer cannot represent leaves the connection asking for no values, while the provider issues two. That mismatch is correctly scored as technical. Step 4's sandboxed connector is what removes it.
3. **Wasted model calls on an unsupported sign-in.** The model repair was called twice after the loop had already hit a sign-in it knows it cannot perform. A known capability gap should stop the loop before the model is asked.

These three are fixed after this write-up. None of them turns vaultbank into a success.

**After the fixes** (`2026-09-28-heldout-agent-after-step-2-fixes`, vaultbank only): still blocked, as expected. The reason is now the manifest's: "The "signed" sign-in scheme uses signed requests (AWS Signature, HMAC), which is not supported yet." It spent no model calls (it spent two before). Defect 2 stands until step 4.

## Population

Unchanged. Nothing in these runs suggests adding or removing a category yet; the held-out set is too small to say.
