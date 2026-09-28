# Onboarding benchmark: protocol

This protocol measures how well Dash turns documentation, credentials and a plain-language goal into a working dashboard. It is written down before any integration agent is run against the benchmark. A change to it is a deliberate, dated entry at the bottom, never a quiet edit.

The code lives in `apps/server/src/bench/`. Results go in `bench/results/`.

## What a scenario is

A **scenario** is three inputs and one answer:

1. **Documentation**: the URL a person would paste.
2. **Credentials**: the values a person would paste, in the order they are asked for.
3. **An objective card**: one sentence a person would say ("How many invoices are still open?").
4. **The answer**: the correct number, with a stated tolerance.

The answer is computed from the provider's seed data by reference code in the provider's own file. It never comes from the pipeline being measured. The integrator under test sees the first three inputs and never the fourth.

## Population

The population is a *provisional best guess*, revisited at each checkpoint:

- Business SaaS APIs with public documentation that a small business would connect: accounting, payments, CRM, support, project management, e-commerce and property management.
- REST, and GraphQL where offered.
- Credentials a non-developer can obtain from the provider's settings page.

Each provider records why it is in the corpus (its `pattern`), so the population changes on purpose rather than by drift.

The corpus has three sources:

- **Mock providers** (`apps/server/src/bench/providers/`). Each one is a small in-process API with documentation, seeded data and answer keys, and each exercises one hard pattern. They run offline, deterministically and for free, so they are what CI runs.
- **Recorded public APIs**. Real providers, recorded once through the record/replay transport. Recordings are sanitized: credentials are removed, and values are kept only for benchmark corpora.
- **Live runs**. By hand only, like the `eval:*` scripts. **Never Rentvine.** Buildium only with the owner's go-ahead, and read-only.

## Splits

- **Dev set.** Used freely while building. Prompts and repair strategies may be tuned against it.
- **Held-out set.** Run only at the end of plan steps 2–4 and at the checkpoints. Its results are recorded, never tuned against. A held-out failure is not debugged by changing a prompt until the checkpoint has been written up. After that, the scenario moves to the dev set and a replacement is written first.

Answer keys for both splits are fixed before the integrator they measure is run.

## Scores

Each dimension is scored separately and never merged into one number that could hide a weak one.

| Dimension | Values | Meaning |
|---|---|---|
| Setup | `done` / `stopped:<stage>` | The integrator produced a connection and a widget for the objective. |
| Interventions | counts by kind | **Technical** (a config edit, or a question about headers, pagination, paths or auth styles) counts against success. **Intent**, **consent** and **account** (values only the person has) are allowed, but counted. |
| Retrieval | `ok` / `error` / `none` | The widget's read succeeded against the provider. |
| Completeness | `complete` / `incomplete-flagged` / `incomplete-silent` / `n/a` | The records read, compared with how many the provider holds. An incomplete read that says so is better than a silent one, and each is counted apart. |
| Metric | `correct` / `wrong` / `n/a` | The widget's number against the answer key, within tolerance. |
| Cost | requests, model calls, wall time | Requests to the provider; model calls by the integrator. |

**Task success** requires all of: setup `done`, zero technical interventions, retrieval `ok`, completeness `complete` and metric `correct`.

**Known-provider reuse** (a second connection to a provider already verified in the catalog) is reported in its own table and never mixed into the unseen-provider numbers. Otherwise a strong catalog could hide weak discovery.

## Targets

There is **no pass/fail threshold yet**. High coverage (90% and above) is the *direction*, not an acceptance gate, because nothing measures it today.

- The first held-out run sets a **baseline**.
- Each later run reports the change against that baseline, with failures sorted by cause: which stage, and which capability was missing.
- A numeric target is set only once there are enough runs to make one meaningful.

## Integrators

The benchmark measures an **integrator**: whatever turns the three inputs into a connection and a widget. Two exist or are planned:

- **`baseline`**: today's pipeline with no repair. Discovery, then a connection from the catalog entry, then credentials in the order asked. In CI its choice of endpoint and measure comes from the scenario's `scripted` field. Those runs test the harness's mechanics and the non-judgment half of the pipeline, **not** anybody's judgment, and are never reported as success rates.
- **`agent`** (plan step 2, `apps/server/src/integrate/`): the baseline's first steps, then the discover → propose → execute → inspect → repair → verify loop over the objective's endpoint. It is measured on the same scenarios with the same scorer. Its endpoint choice is still scripted in these runs; choosing unscripted goes through the brief path, in live runs. Since plan step 4, when no repair can express what an API needs, the loop writes connector code (the `connector` model task) and proves it in the sandbox. In a scripted run that code is the provider's scripted answer, so it measures the mechanics. Only a `--live` run measures a model writing it.

## Running it

```bash
pnpm bench                       # dev split, the agent, scripted choices
pnpm bench --integrator baseline # today's pipeline with no repair, for comparison
pnpm bench --split heldout --checkpoint "<name>"   # held-out: only at a checkpoint
```

## Changes to this protocol

- 2026-09-26: written before any integration agent exists.
- 2026-09-28: `searchy` (a POST search paged in its body), `oauthco` (OAuth sign-in, tokens good for three requests, rotating refresh tokens) and `filterly` (a required deepObject filter with a documented default) added to the dev set. OAuth scenarios sign in through a scripted person, counted as consent.
- 2026-09-28: `quotient` (OAuth client credentials with expiring tokens, a POST search) and `ledgerline` (OAuth sign-in with PKCE and rotating refresh tokens, a deepObject filter, a total in a header) added to the held-out set **before any of plan step 3 was built**. Their reference connections are written once step 3 can express them.
- 2026-09-28: `billhub` and `keyring` added to the dev set (a wrong address in the spec, a misnamed sign-in header), before the agent was run against them. The `agent` integrator added. See `results/checkpoint-step-2.md`.
- 2026-09-28: `sessionly` (a login for a session token that ends after a few requests, records one JSON object per line, pages by the last id) and `stampede` (a request id never sent before and the current time on every request) added to the dev set for plan step 4, before the agent was run against them. Their patterns are deliberately not vaultbank's. Their scripted `connector` answers test the mechanics only.
- 2026-09-28: A scenario may carry the provider's own label for each credential (`credentialLabels`): what a person reads on their settings page to paste each value into the field asking for it. Values are pasted by label where both sides have one, otherwise in the order asked. Added to sessionly, stampede and — before its checkpoint run, changing neither its API nor its answer — vaultbank.
- 2026-09-28: The agent integrator counts a mismatch between the values asked for and the values the provider issues against the connection as it ends up, not as first imported. When the loop writes connector code that declares its own sign-in, the person is asked for those values then, as the product asks once the check reports them, and the check runs again. The baseline is unchanged.
- 2026-09-28: vaultbank's reference connection written by hand, to prove its answer key, once connector code could express it. It is never shown to an integrator. The held-out split has no scripted connector code, so a scripted run stops where a model would have to write one; connector authoring on the held-out split is measured with `--live`.
- 2026-09-28: Results files are never overwritten (a second run gets `-2`), and a `--only` or `--live` run says so in its name. Before this rule, `2026-09-28-dev-agent` was written three times: at the end of plan step 2 (10 of 10), at the end of step 3 (13 of 13), and by a partial run during step 4, whose file was renamed `…-only-sessionly-stampede`. The first two runs' files are lost; their figures survive in `results/checkpoint-step-2.md` and `checkpoint-step-3.md`.
- 2026-09-28: After the end-of-step-4 checkpoint was written up (`results/checkpoint-step-4.md`), **vaultbank moved to the dev set**, and **`harborline` was added to the held-out set as its replacement**, before any fix. Harborline's pattern is a token obtained with an HS256-signed JWT assertion, every record in pre-signed files on a separate host that refuses the API's token, and tab-separated. Its answer key was proven by a hand-written reference before any integrator ran against it. Writing that reference exposed a capability gap: the assertion must carry the key ID, and connector code never receives a pasted value. The reference hard-codes its own key ID, as a person configuring their own account could; an integrator cannot. The capability (pasted identifiers the code may read) is built after this entry, as step 3's were after quotient and ledgerline.
- 2026-09-28: Fixed after the step 4 write-up, and before harborline or vaultbank ran again: a proposal's `cannot` is a refusal only when no code comes with it (a caveat beside code is kept as an assumption, and the code tried); connector credentials can be declared identifiers (`secret: false`) that the code may read, never one named like a secret; a failed scenario's result keeps the integrator's log. Harborline's reference now reads its key ID as an identifier instead of hard-coding it. Its answer key is unchanged and re-proven. Vaultbank, now a dev scenario, has scripted connector code for CI.
- 2026-09-28: Checkpoint 1 written (`results/checkpoint-1.md`), with every model call live for the first time. Fixed after it, from dev-set failures (sessionly, stampede):
  - connector code is kept only when its read did not stop short;
  - a connector's own read may go to the platform's page ceiling;
  - a login is not passed through `signRequest` unless the code asks;
  - a result keeps the integrator's log wherever a model was used.
