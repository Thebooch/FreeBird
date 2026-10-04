# Onboarding benchmark: results

The benchmark gives Dash what a person would give it:
- a documentation URL;
- credentials;
- one sentence, such as "How many invoices are still open?".

It scores the number that comes back against an answer key fixed before anything ran. `PROTOCOL.md` says how. This page keeps the latest figures. Each run's own report is written to `bench/results/` by `pnpm bench`, and is not committed.

## Latest (2026-10-03)

Every model call was live (`gpt-5.6-terra`). Every run was **unscripted**: the integrator is given the sentence alone, and chooses the endpoint and the measure itself, as the product does.

| Split | What it is | Scenarios | Correct | Wrong, and not said |
|---|---|---|---|---|
| **Held-out** | Mock APIs written by an author who never reads the integration code, and never tuned against | 12 | **6** | 1 |
| Real | Public APIs that need no key, read over the network | 12 | 12 | 0 |
| Dev | Mock APIs used, and tuned against, while building | 34 | 33 | 0 |

**The held-out figure is the one that measures unseen APIs.** Dev and real have been tuned against, so they show that nothing regressed, not how Dash does on an API it has never seen. On unseen APIs, it is six in twelve.

- All three are from checkpoint 7.
- **Dev's one miss** was harborline, whose model-written connector code failed in that run, so no record type could be described. Run again, it was correct (470 of 470). Model-written code varies run to run; chargebolt did the same at checkpoint 6.
- Two new dev providers, written for the kinds of gap this work closed and never from a held-out file:
  - longhaul: 1,200 records past the page ceiling;
  - drawnhub: documentation drawn by its own script.
  Both are correct.
- "Correct" is the protocol's task success. It means:
  - the connection was set up with no technical help;
  - the read was complete;
  - the number was within the answer key's tolerance.
- A number that is wrong or incomplete and says so on its tile is counted apart from one that says nothing. Only one result, trackwell below, was wrong and said nothing.

## Held-out, by provider

| Provider | Unscripted | Endpoint and measure scripted |
|---|---|---|
| stockroom, helpline, quotient, ledgerline, brightbooks | correct | correct |
| keyholder | correct | the key was refused however it was sent; stopped, and said so |
| payrail | **read all 1,150** (500 at checkpoint 6); wrong, and said why: the request filters by the customer's country, which no read here can express | the list endpoint was never imported |
| deskpoint | first page only (21 of 508), and said so | the same |
| trackwell | **read 50 of 264 and gave a wrong number without saying so** (unchanged) | the search endpoint was never imported; stopped, and said so |
| marketlane | stopped: reading orders needs the seller's marketplaces first, a read in two steps | the list endpoint was never imported |
| pipeforce | no record type fits the request | signing in did not finish |
| leasewise | no record types could be described | the key was refused (403) |

**Trackwell, measured first, then studied.** Trackwell was measured before it was studied. Neither checkpoint 6 nor 7 changed its unscripted result: it read 50 of 264 and said nothing. After checkpoint 7 it was studied, so it is now a dev provider. Its replacement, staffnest, is written and wired in, and is first measured at the next checkpoint (`PROTOCOL.md`, 2026-10-03).

## Why the rest failed

These are the unscripted causes, in the order they cost:
1. Record types that could not be described, or none that fit: two (leasewise, pipeforce).
2. Paging never confirmed: one (deskpoint).
3. A filter on another record type than the one counted: one (payrail). Its paging gap is closed: reads now carry on past the page ceiling.
4. An endpoint the import never found, so the read was of another one: one (trackwell).
5. A read in several steps the loop would not attempt: one (marketlane).

## Over time

These are held-out figures. The set changes between checkpoints: a provider whose failure is studied moves to the dev set, and a new provider replaces it (`PROTOCOL.md`).

| Checkpoint | Date | Held-out correct | Held-out wrong, and not said | Real correct |
|---|---|---|---|---|
| 1 | 2026-09-28 | 5 of 5 (endpoint and measure scripted) | 0 | — |
| 2 | 2026-09-29 | 4 of 12 | 0 | 5 of 12 |
| 3 | 2026-09-29 | 5 of 12 | 1 | 11 of 12 |
| 4 | 2026-09-29 | 5 of 11 | 2 | 12 of 12 |
| 5 | 2026-09-30 | 5 of 12 | 1 | 12 of 12 |
| 6 | 2026-10-02 | 6 of 12 | 1 | 12 of 12 |
| 7 | 2026-10-03 | 6 of 12 | 1 | 12 of 12 |

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
- **Clean measurements everywhere.** Three held-out results are not clean: deskpoint, pipeforce and payrail. (Trackwell was a fourth, until it was studied and moved to dev.) Generic work was done for the gaps their outcome lines named, without reading their files, so their later results partly measure that work.
- **A sealed held-out set.** Once, a search of the source printed one line of a held-out file. It showed that some provider pages by Link header. Nothing was built from it: that kind of paging was already supported. Once more, a scan of the history for real credentials printed six of the held-out providers' mock credentials, which the integrator is given anyway (`PROTOCOL.md`, 2026-10-04).
