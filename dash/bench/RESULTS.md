# Onboarding benchmark: results

The benchmark gives Dash what a person would give it:
- a documentation URL;
- credentials;
- one sentence, such as "How many invoices are still open?".

It scores the number that comes back against an answer key fixed before anything ran. `PROTOCOL.md` says how. This page keeps the latest figures. Each run's own report is written to `bench/results/` by `pnpm bench`, and is not committed.

## Latest (2026-09-30)

Every model call was live (`gpt-5.6-terra`). Every run was **unscripted**: the integrator is given the sentence alone, and chooses the endpoint and the measure itself, as the product does.

| Split | What it is | Scenarios | Correct | Wrong, and not said |
|---|---|---|---|---|
| **Held-out** | Mock APIs written by an author who never reads the integration code, and never tuned against | 12 | **5** | 1 |
| Real | Public APIs that need no key, read over the network | 12 | 12 | 0 |
| Dev | Mock APIs used, and tuned against, while building | 27 | 27 | 0 |

**The held-out figure is the one that measures unseen APIs.** Dev and real have been tuned against, so they show that nothing regressed, not how Dash does on an API it has never seen. On unseen APIs, it is five in twelve.

- The held-out figure is from checkpoint 5. Dev and real are from the regression run after the last change, the same day.
- "Correct" is the protocol's task success. It means:
  - the connection was set up with no technical help;
  - the read was complete;
  - the number was within the answer key's tolerance.
- A number that is wrong or incomplete and says so on its tile is counted apart from one that says nothing. Only one result, trackwell below, was wrong and said nothing.

## Held-out, by provider

| Provider | Unscripted | Endpoint and measure scripted |
|---|---|---|
| stockroom, helpline, quotient, ledgerline, brightbooks | correct | correct |
| deskpoint | first page only (21 of 508), and said so | the same |
| trackwell | **read 50 of 264 and gave a wrong number without saying so** | the search endpoint was never imported |
| payrail | stopped at 50 pages (500 of 1,150); wrong, and said so | the list endpoint was never imported |
| marketlane | the endpoint needs a value a board cannot supply | the list endpoint was never imported |
| pipeforce | no record type fits the request | signing in did not finish |
| leasewise | no record types could be described | the key was refused (403) |
| keyholder | no record types could be described | the key was refused however it was sent |

## Why the rest failed

These are the causes, in the order they cost:
1. Endpoints the import never found: three.
2. Record types that could not be described from what was read: two.
3. Paging: two. One provider's paging was never confirmed. The other stopped at the most pages a read may take.
4. Sign-in: two.
5. A required input that a board cannot supply: one.

## Over time

These are held-out figures. The set changes between checkpoints: a provider whose failure is studied moves to the dev set, and a new provider replaces it (`PROTOCOL.md`).

| Checkpoint | Date | Held-out correct | Held-out wrong, and not said | Real correct |
|---|---|---|---|---|
| 1 | 2026-09-28 | 5 of 5 (endpoint and measure scripted) | 0 | — |
| 2 | 2026-09-29 | 4 of 12 | 0 | 5 of 12 |
| 3 | 2026-09-29 | 5 of 12 | 1 | 11 of 12 |
| 4 | 2026-09-29 | 5 of 11 | 2 | 12 of 12 |
| 5 | 2026-09-30 | 5 of 12 | 1 | 12 of 12 |

At checkpoint 1, the unscripted path and the real split did not exist yet.

## Cost

These figures were measured at checkpoint 1.

| Kind of API | Model calls | API requests | Time |
|---|---|---|---|
| Described by an OpenAPI document | 0 | 2–30 | under 0.1 s against the mocks |
| Documented in prose | 1 | 2 | 2.4 s |
| Needs connector code | 2–4 | 4–11 | 10–44 s, mostly the model; about $0.06 |

## What this does not show

- **Variance.** Each checkpoint is one run.
- **The population.** The mock providers are modelled on business SaaS APIs, but they are synthetic. The real split is public demo APIs that need no key. Neither is the set of business APIs the protocol names.
- **A large sample.** Twelve held-out providers is a small number.
- **Clean measurements everywhere.** Three held-out results are not clean: deskpoint, trackwell and pipeforce. Generic work was done for the gaps their outcome lines named, without reading their files, so their later results partly measure that work.
- **A sealed held-out set.** Once, a search of the source printed one line of a held-out file. It showed that some provider pages by Link header. Nothing was built from it: that kind of paging was already supported.
