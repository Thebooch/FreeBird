# Checkpoint 1: the decision point after plan steps 1–4

Recorded before anything was changed in response to it. See `PROTOCOL.md`. This is a measured baseline, not a pass or fail against a target: the 90% figure is a direction, and nothing here is scored against it.

## The thesis being tested

Given documentation, credentials and an objective, produce a working dashboard number with nobody editing technical configuration. Steps 1–4 built:
- the honesty fixes and the compatibility manifest;
- the integration loop (repairs, the paging probe, evidence);
- reads sent with POST, parameters and OAuth;
- sandboxed connector code for what a connection cannot describe.

## Runs at this checkpoint

Every model call in these two runs was live: `gpt-5.6-terra`, the capable tier on the default provider — discovery, repairs and connector code alike. Endpoint and measure choices were still scripted (see "What is not measured").

| Run | Split | Scenarios | Task success | Technical interventions | Incomplete, silently |
|---|---|---|---|---|---|
| `2026-09-28-heldout-agent-checkpoint-1-live` | **held-out** (5 providers) | 5 | **5** | 0 | 0 |
| `2026-09-28-dev-agent-checkpoint-1-live` | dev (14 providers) | 16 | **14** | 0 | 0 |

### Each dimension, separately

| | Held-out | Dev |
|---|---|---|
| Setup done | 5 / 5 | 16 / 16 |
| Scenarios with a technical intervention | 0 | 0 |
| Consent interventions (an OAuth sign-in) | 1 | 1 |
| Retrieval ok | 5 / 5 | 16 / 16 |
| Complete | 5 / 5 | 14 / 16 |
| Incomplete, and said so | 0 | 2 |
| Incomplete, silently | 0 | 0 |
| Metric correct | 5 / 5 | 14 / 16 |

### Against the step 2 baseline

The first held-out run (end of step 2) had three providers:
- **Stockroom:** succeeded then and now.
- **Helpline:** succeeded then and now.
- **Vaultbank:** blocked then, on signed requests and a multi-step CSV read. It is a dev scenario now, after its step 4 failure was written up, and it succeeds with model-written code.

The held-out set grew to five with quotient and ledgerline (OAuth, POST searches; step 3) and harborline (connector code; step 4). Every held-out provider now reaches its answer.

| End of | Held-out task success |
|---|---|
| Step 2 | 2 of 3 |
| Step 3 | 4 of 5 |
| Step 4, first attempt | vaultbank 0 of 1 (a contract defect) |
| Step 4, after the fix | harborline 1 of 1 |
| This checkpoint | 5 of 5, every model call live |

## Cost per onboarding

| Kind of API | Model calls | API requests | Time |
|---|---|---|---|
| Described by its OpenAPI document (stockroom, helpline, quotient, ledgerline, and 11 dev scenarios) | **0** | 2–30 | under 0.1 s against the mocks |
| Documented in prose (prosebook) | 1 | 2 | 2.4 s |
| Needs connector code (harborline, vaultbank, sessionly, stampede) | 2–4 | 4–11 | 10–44 s, mostly the model |

Harborline's four calls took 12,725 input tokens (a third of them cached) and 4,090 output tokens: **$0.064**. The dev run's nine calls cost about the same per call ($0.007–$0.017 each). The run did not total them, and the next one will.

What stands out is how rarely a model is needed. Every provider described by a specification — the whole held-out set but one — was read correctly with deterministic code alone: the importer, repairs from the documentation, and a probe that reads the second page.

## Failures, by cause

### At this checkpoint

| Provider | Split | Result | Cause |
|---|---|---|---|
| sessionly | dev | 50 of 230 records, wrong total, flagged on the tile | The loop kept connector code that said it had stopped early. It took a read that returned any records as proof, including one whose code reported `complete: false`. |
| stampede | dev | 100 of 180 records, wrong total, flagged on the tile | Same defect. The model's code stopped at `ctx.maxPages` — 5, the default for an endpoint whose paging is unconfirmed — and said so; the loop kept it. |

Both are the loop's fault, not the model's: its code said it was incomplete, the product said so on the tile, and the loop should not have accepted it. With scripted code, both scenarios passed (16 of 16 at the end of step 4). **A scripted run overstated what the loop does with model-written code.**

**A second defect, visible in sessionly's log:** `auth.exchange` passes the login request through the code's `signRequest`. When `signRequest` adds the session token, the login itself asks for a token that does not exist yet, and is refused. The model worked around it on its third attempt. The environment should not have required it.

**Cosmetic:** a connector failure repeats its own text as "the API said: …" in the feedback the model gets.

### Across steps 1–4, by missing capability

| When | Provider | Missing | Now |
|---|---|---|---|
| Step 2 | vaultbank | signed requests, multi-step reads, CSV | Connector code (step 4) |
| Step 4 | vaultbank | a way to say "I assumed this" beside code | Fixed (`assumptions`) |
| Step 4 (writing harborline) | harborline | code reading a pasted key ID | Fixed (declared identifiers) |
| This checkpoint | sessionly, stampede | the loop checking that connector code read everything | Not fixed yet |

## What is not measured — the largest gaps in this evidence

1. **Judgment.** Every run scripts which endpoint answers the objective and how to compute it. The benchmark measures getting a chosen endpoint read completely and correctly; it has never measured choosing it. The product's brief path (`writeBrief` → `compileBrief`) exists, but the benchmark has no unscripted path through it. This is half the thesis.
2. **Real APIs.** Every provider is a synthetic mock, written in this project, by the same author as the loop they measure. The protocol's second source — recorded public APIs — has not been built. Author bias is the obvious risk: patterns I think of are the ones I built for.
3. **Models.** One model, once per scenario. Model-written code varies from run to run: vaultbank took 2 calls here and failed once before.
4. **Scale.** Five held-out providers. A baseline, not a rate.

## The population

The provisional population — business SaaS APIs with public documentation, REST and GraphQL, credentials a non-developer can get — still looks right. Nothing measured argues against it. Coverage by category:

| Category | Providers |
|---|---|
| Accounting | ledgerly, billhub, ledgerline |
| Payments | multicur, vaultbank |
| CRM | quotient |
| Support | helpline, sessionly |
| Project management | taskpad, oauthco |
| E-commerce | stockroom, searchy, stampede, harborline |
| Property management | rentroll |

To add:
- recorded real APIs from each category;
- GraphQL (none measured end to end);
- documentation that is HTML only, with no specification (prosebook is the only prose provider);
- APIs whose documentation is wrong in ways not already built for.

A held-out set written by someone other than the loop's author would be worth more than any number of mine.

## FreeBird `guide/`

**No changes were needed, and none were made.** The integration loop runs on the server, by itself, and never goes through the chat engine. `ChatEngine`'s loop limits (`maxToolSteps`) matter only if integration is later driven from chat, which nothing here needs.

## The sandbox's authority model

It held wherever it was tested, and it was tested deliberately rather than by the live runs:
- 20 containment tests in `connector/connector.test.ts` make each attempt it exists to stop;
- one refusal in the live runs was the model's own honest mistake (a token used before it existed), and the host refused it, as designed.

The residual risks are listed in `PLATFORM.md`, including two added in step 4:
- a signature carried in transformed form;
- a secret declared an identifier under an innocent name.

Nothing in these runs tried to get round it, so the live runs are not evidence that it cannot be.

## The decision

The owner chooses one of: continue, ordering step 6's tracks by measured failures; change the approach; re-scope the target. Measured failures, at this point, order almost nothing: the held-out set passes, and the dev failures are one defect in the loop. What the evidence mostly shows is where it is thin: judgment and real APIs.

---

## After the fixes

Everything above was written before this. The three defects above were fixed, with the dev-set failures that exposed them:
- connector code is kept only when its read did not stop short, and one that did is sent back to the model with what happened;
- a connector's own read may go to the platform's page ceiling (50), not an unconfirmed endpoint's default of 5;
- a login is not passed through `signRequest` unless the code asks.

A result now keeps the integrator's log wherever a model was used. Every model call was again live (`gpt-5.6-terra`).

| Run | Split | Scenarios | Task success | Technical interventions | Model calls | Model cost |
|---|---|---|---|---|---|---|
| `2026-09-28-dev-agent-checkpoint-1-after-fixes-live` | dev | 16 | **16** | 0 | 7 | $0.052 |
| `2026-09-28-heldout-agent-checkpoint-1-after-fixes-live` | **held-out** | 5 | **5** | 0 | 2 | $0.026 |

Sessionly and stampede, with model-written code, now read 230 of 230 and 180 of 180 records, and both totals are correct. Harborline took 2 calls this time (4 before).

**The authority model, in a live run.** Harborline's documentation never names its file host. The model's first code did not list it, and the server refused the request before it left. The loop showed the model the refusal, and the model declared the host a download destination: never given a credential, and reachable only at addresses the API itself returned. The next read got all 470 records. This is the control working on an honest mistake. Nothing in these runs tried to get round it.

## Where this leaves the decision

On a small synthetic set that its author wrote, the loop now gets every scripted objective — dev and held-out — to a correct, complete number, with nobody editing configuration. It needs no model at all for APIs described by a specification, and 1–4 calls ($0.01–$0.06) for one that needs code.

The evidence is thin in the two places that matter most for the thesis:
- **choosing** what to read — every run is scripted;
- **real APIs** — none have been measured.

## The owner's decision (2026-09-28)

**Measure first.** Before step 6's tracks, close the two measurement gaps:
1. an **unscripted path**: the objective card alone, with the model choosing the endpoint and the measure through the product's brief path, scored against the same answer keys;
2. a **corpus of recorded real public APIs** (record/replay; never Rentvine; Buildium only with the owner's go-ahead).

Then order tracks A–H by what those two measure.

**Held-out APIs are written by a separate agent session** from now on. It works from a brief of real-world patterns, with no access to the loop's code or prompts, so the loop's author is no longer also its examiner. This session wires those providers in and runs them at checkpoints, without reading their patterns.
