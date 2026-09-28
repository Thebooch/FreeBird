# Checkpoint: end of plan step 4 (sandboxed connector code)

Recorded before anything was changed in response to it. See `PROTOCOL.md`.

## Runs

| Run | Integrator | Split | Model | Scenarios | Task success | Incomplete, silently |
|---|---|---|---|---|---|---|
| `2026-09-28-dev-agent-end-of-step-4` | agent | dev (13 providers) | scripted | 15 | 15 | 0 |
| `2026-09-28-heldout-agent-end-of-step-4` | agent | **held-out** | scripted | 5 | 4 | 0 |
| `2026-09-28-heldout-agent-end-of-step-4-only-vaultbank-live` | agent | **held-out**, vaultbank only | `gpt-5.6-terra` | 1 | **0** | 0 |

Endpoint choices were scripted in every run. In the scripted runs the connector code is the provider's own scripted answer, so those runs measure the mechanics — the sandbox, the authority, credentials, the loop. Only the live run measures a model writing connector code, and only for vaultbank.

## The unfamiliar test: vaultbank, with a live model

Vaultbank was written before plan step 2 and not run with connector code until now. Its API signs every request with an HMAC of the method, path and time, and holds its transactions only behind an export: start it with a POST, poll it, then download a CSV at the address it gives. None of that is in any prompt, dev mock or seeded module.

**Result: stopped at integrate. Step 4's acceptance criterion is not met on this run.**

- The loop reached the sandbox path: nothing it could repair would express the API, so it asked the `connector` task for code.
- The model answered with code, and also put a note in the proposal's `cannot` field: *"The documentation does not define the possible export status values or the polling interval. This connector treats status "ready" as complete and polls once per second, bounded by the run page limit."*
- The loop reads any `cannot` as the model declining. It stopped without loading or running the code, so **no request reached the API and the code was never tried.** Whether that code would have read the export is unknown, and is not something this checkpoint may find out by re-running it.
- 2 model calls, $0.018; 0 API requests; 0 technical interventions.

**Cause: a defect in the loop's contract with the model, not in the sandbox.** `cannot` was described as "when the documentation does not say enough to write this", and there was nowhere else to say "I assumed this". A model that wrote code but flagged its assumptions had only that field to flag them in. The mistake is in reading the field, which is general to any API whose documentation leaves something unstated — most of them.

**A second gap: the record could not say more.** A results file keeps each scenario's stop reason, not what the integrator logged, so this write-up cannot say which call the other model call was, or what code the model wrote. Diagnosing more would mean running the held-out scenario again, which the protocol forbids.

## The scripted held-out run

Stockroom, helpline, quotient and ledgerline passed again under step 4's code (260/260, 415/415, 230/230, 380/380, every answer correct): nothing in this step broke what steps 2 and 3 do. Vaultbank stopped where a model has to write code, as a scripted run must — the held-out split has no scripted connector answer — and was counted as one technical intervention (the connection asked for 0 values where the provider issues 2).

## Failures, by cause

| Provider | Run | Stage | Cause |
|---|---|---|---|
| vaultbank | live | integrate | The loop read a proposal's `cannot` note as a refusal and never ran the code it came with |
| vaultbank | scripted | integrate | No scripted connector code on the held-out split — by design, not a result |

## What happens next, per the protocol

1. **Vaultbank moves to the dev set.** Its failure has been seen; from here it is something to tune against, not a measurement.
2. **A replacement unfamiliar workflow is written before any fix**, with its answer key fixed and proven by a reference connection, and a pattern that is neither vaultbank's nor the dev set's.
3. Then the defect is fixed: a place for assumptions in the proposal, and `cannot` taken as a refusal only when no code comes with it. Each result also keeps the integrator's log from then on.
4. Vaultbank is re-run as a dev scenario, and the replacement as the new held-out measurement. Both are reported below this line, marked as after the fix.

## Built in this step, and what it does not claim

- A `ConnectorSandbox` plug-in point: QuickJS in WebAssembly, one worker thread and a fresh interpreter per run, with memory, CPU and wall-clock caps. Its authority is enforced by the server on every request: listed hosts and methods, credentials bound to hosts, signatures made server-side, downloads only at addresses the API gave, echoed credentials removed. `connector/connector.test.ts` exercises each control; the residual risks are in `PLATFORM.md`.
- The `connector` model task, and the loop's escalation to it. The loop keeps code only when a read through it returns records, revises it with what happened (never a credential), and asks for the credentials it declares in the documentation's words.
- Dev set: `sessionly` (a login for a session token, records one JSON object per line) and `stampede` (a new request id and the current time on every request) pass with scripted code. They show the mechanics work. They are not evidence that a model writes such code well.

## Population

Unchanged. One live run on one unfamiliar workflow says nothing about the population yet.

---

## After the fix

Everything above was written before any of this. Order of events, as `PROTOCOL.md` records them:
1. Vaultbank moved to the dev set.
2. `harborline` was written as the held-out replacement, and its answer key proven by a reference, before any fix.
3. Then came the fixes: `cannot` is a refusal only without code, and a caveat is kept as an assumption; pasted identifiers the code may read; a failed result keeps the integrator's log.
4. Then the runs below.

Writing harborline's reference exposed the identifier gap. Its JWT assertion must carry the key ID, and connector code received no pasted value at all. That capability was built after harborline was written and before it ran, as step 3's were after quotient and ledgerline. Nothing about harborline's API, documentation or answer changed.

| Run | Integrator | Split | Model | Scenarios | Task success | Incomplete, silently |
|---|---|---|---|---|---|---|
| `2026-09-28-dev-agent-end-of-step-4-after-fix` | agent | dev (14 providers, vaultbank now among them) | scripted | 16 | 16 | 0 |
| `2026-09-28-heldout-agent-end-of-step-4-after-fix` | agent | held-out | scripted | 5 | 4 | 0 |
| `2026-09-28-heldout-agent-end-of-step-4-after-fix-only-harborline-live` | agent | **held-out**, harborline | `gpt-5.6-terra` | 1 | **1** | 0 |
| `2026-09-28-dev-agent-end-of-step-4-after-fix-only-vaultbank-live` | agent | dev, vaultbank | `gpt-5.6-terra` | 1 | 1 | 0 |

**Harborline — the unseen measurement: task success.** A model wrote code that:
- signed a JWT assertion with the secret, carrying the key ID, and exchanged it for a token;
- read the manifest;
- fetched three pre-signed files from a separate host, without the token that host refuses;
- parsed the tab-separated files.

It read 470 of 470 records, and the delivered weight for August matched the answer key (31,939.5 kg). No technical intervention; 11 API requests; 4 model calls, $0.054. A success keeps no log, so how many of the four calls were revisions is not recorded.

**Vaultbank — no longer unseen: task success.** With the contract fixed, a model's code signed every request, started the export, polled it, and read the CSV: 640 of 640 records, the correct total (123,953.40), 2 model calls, $0.019. That the misread `cannot` was what stopped it the first time is likely, not proven: a model's answers vary from run to run.

**The scripted held-out run** shows the four providers from steps 2 and 3 unchanged. Harborline stops there, as a scripted run must: no scripted connector code on the held-out split.

### What the numbers are, and are not

- **Step 4's acceptance criterion** — an unfamiliar workflow reaching its answer key without technical intervention — **was met on the replacement, after a fix, not on the first attempt.** The first attempt's failure stands in the record above.
- One unseen workflow and one live model make a baseline, not a rate. The live runs used one model, once each. Scripted runs never measure a model's judgment.
- Connector code is kept because its read returned records; the answer keys are what showed they were the right records. Outside the benchmark, nothing checks that.
- The live runs measured the `connector` task on `gpt-5.6-terra`, the capable tier on the default provider. Other models are unmeasured.

## For the decision checkpoint (step 5)

- **Held-out record so far:**

  | End of step | Task success |
  |---|---|
  | Step 2 | 2 of 3 |
  | Step 3 | 4 of 5 |
  | Step 4, first attempt | vaultbank 0 of 1 |
  | Step 4, after the fix | harborline 1 of 1 |

  All synthetic, all with scripted endpoint choices. The step 4 figures are live connector authoring.
- **Cost of an unfamiliar workflow:**

  | | Model calls | Requests | Cost |
  |---|---|---|---|
  | Harborline | 4 | 11 | $0.054 |
  | Vaultbank | 2 | 10 | $0.019 |

  Opening a sandbox run costs about 300 ms.
- **The authority model was not tested by the live runs.** Nothing in them tried to get round it, and a successful run keeps no log, so whether the models' code was refused anything on the way is not recorded. The containment tests exercise each control against a deliberate attempt, and the residual risks are in `PLATFORM.md`.
- **Not built, and needed before this is a product path:**
  - choosing which endpoint connector code should serve without an objective (the unscripted brief path);
  - the setup screen offering to describe by hand a sign-in only code can do;
  - changes through a connector;
  - a hosted sandbox behind the same interface.
