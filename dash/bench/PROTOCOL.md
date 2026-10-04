# Onboarding benchmark: protocol

This protocol measures how well Dash turns documentation, credentials and a plain-language goal into a working dashboard. It was written down before any integration agent was run against the benchmark. A change to it is a deliberate, dated entry at the bottom, never a quiet edit.

The code lives in `apps/server/src/bench/`. Each run writes its report to `bench/results/`, which is not committed. `RESULTS.md` keeps the latest figures.

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

The corpus has these sources:

- **Mock providers** (`apps/server/src/bench/providers/`). Each one is a small in-process API with documentation, seeded data and answer keys, and each exercises one hard pattern. They run offline, deterministically and for free, so they are what CI runs.
- **Real public APIs** (the `real` split, `providers/real.ts`). Public APIs that need no key: DummyJSON, JSONPlaceholder, Rick and Morty, PokéAPI, Open Brewery DB and Cat Facts. They are reached over the network through the server's SSRF guard, and only on their own hosts.
  - Answer keys come from a snapshot of the full data taken by `real/snapshot.mts`, with at most two documented requests each (the first may say how many there are). They were fixed before any integrator ran against them.
  - Each key is checked against the live API before scoring. A changed API is reported as a stale key (`stopped:stale-key`), never scored.
  - By hand only, never in CI.
- **Recorded public APIs**. Real providers, recorded once through the record/replay transport. Recordings are sanitized: credentials are removed, and values are kept only for benchmark corpora.
- **Live runs against an account**. By hand only, like the `eval:*` scripts: read-only, and only on an account whose owner has agreed to it.

## Splits

- **Dev set.** Used freely while building. Prompts and repair strategies may be tuned against it.
- **Held-out set.** Run only at checkpoints. Its results are recorded, never tuned against.

Answer keys for both splits are fixed before the integrator they measure is run.

How the held-out set stays held out:

- **Who writes it.** Held-out providers are written by a separate author who does not read the integration loop, the importers or any result (`HELDOUT-AUTHORING.md`). They are wired in without being read. Each answer key is proven by a hand-written reference connection before any integrator runs against it.
- **What is read.** Only a held-out run's outcome lines. Searches of the source leave the held-out files out.
- **When a provider leaves.** A held-out failure that is studied moves the provider to the dev set. Studying it means reading its log, or building a fix from its outcome line. A replacement is written first, before that fix lands.
  - Moved so far, each after its failure was studied: vaultbank, harborline, chargebolt, shopwell and cashloom.
- **Generic work.** Work written for the kind of gap an outcome line names doesn't move the provider, provided it doesn't read the provider and is proven on a dev provider made for it. But the provider's later results then measure that work and are no longer clean held-out measurements. A report says so.
- **Connector code.** The held-out split has no scripted connector code. A scripted run stops where a model would have to write some. Connector authoring on the held-out split is measured with `--live`.

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

**Task success** requires all of these:
- setup `done`;
- zero technical interventions;
- retrieval `ok`;
- completeness `complete`;
- metric `correct`.

Completeness, where the widget reads fewer records than the collection by design:

- **A read narrowed by the API's own filter.** A widget can narrow through a filter the check confirmed (`source.params`). Such a read holds fewer records than the collection. It is complete when nothing cut it short and any count the API gave matches.
  - The answer key still decides whether it read the right records.
  - The scoring read sends the widget's `source.params`, as a board does.
- **The API's own count.** A widget can read an endpoint the check confirmed counts a record type (`ResourceSpec.count`). It is complete when that one answer was not cut short. Its one row is a number, not records, so "read / held" cannot measure it.

**Wrong, and said why.** Each result keeps anything the tile said beyond missing records (`said`), such as:
- a narrowing it could not apply;
- parts that do not add up;
- that it counts only the board's time range.

The summary counts "wrong, and said why" apart from "wrong, silently". Correctness is unchanged: the answer key still decides.

**Known-provider reuse** (a second connection to a provider already verified in the catalog) is reported in its own table and never mixed into the unseen-provider numbers. Otherwise a strong catalog could hide weak discovery.

## The bench's person

An integrator may ask the person what this protocol allows. The bench answers as a person would:

- **Credentials** are pasted by the provider's own label for each value (`credentialLabels`: what the settings page calls it) where both sides have one. Otherwise they are pasted in the order asked.
  - What is asked for is compared with what the provider issues, against the connection as it ends up, not as it was first imported.
  - When connector code declares its own sign-in, the person is asked for those values then.
- **An account address** is needed where an API lives at an address of each account's own. It is answered from the provider's `accountAddress`, or else its reference connection's address, and counted as an `account` intervention. That one value is all of the reference that ever reaches an integrator.
- **Signing in with a provider** counts as consent. The person presses Allow on the consent page, submitting its form as a browser would. They never type a password into a login form.

## Targets

There is **no pass/fail threshold yet**. High coverage (90% and above) is the *direction*, not an acceptance gate, because nothing measures it today.

- The first held-out run sets a **baseline**.
- Each later run reports the change against that baseline, with failures sorted by cause: which stage, and which capability was missing.
- A numeric target is set only once there are enough runs to make one meaningful.

## Integrators

The benchmark measures an **integrator**: whatever turns the three inputs into a connection and a widget.

- **`baseline`**: today's pipeline with no repair. Discovery, then a connection from the catalog entry, then credentials in the order asked.
  - In CI its choice of endpoint and measure comes from the scenario's `scripted` field.
  - Those runs test the harness's mechanics and the non-judgment half of the pipeline, **not** anybody's judgment. They are never reported as success rates.
- **`agent`** (`apps/server/src/integrate/`): the baseline's first steps, then the discover → propose → execute → inspect → repair → verify loop over the objective's endpoint. It is measured on the same scenarios with the same scorer.
  - When no repair can express what an API needs, the loop writes connector code (the `connector` model task) and proves it in the sandbox.
  - In a scripted run, that code is the provider's scripted answer, so the run measures only the mechanics. Only a `--live` run measures a model writing it.

**Unscripted** (`--unscripted`): the integrator gets the request alone and goes the product's own way:
1. It runs the first check over the connection's own targets, which the product runs by itself once a key is saved.
2. It describes record types from what those reads showed, and the values they held.
3. It writes a brief, and compiles the widget.
4. It runs the integration loop, and observes the first read.

Unscripted runs are scored against the same answer keys. They are live only, since a scripted model would be the answer itself.

## Running it

```bash
pnpm bench                                     # dev split, the agent, scripted choices
pnpm bench --integrator baseline               # today's pipeline with no repair, for comparison
pnpm bench --unscripted --live                 # the request alone, every model call live
pnpm bench --split real --unscripted --live    # public APIs, over the network
pnpm bench --only <id>,<id>                    # some scenarios only
pnpm bench --split heldout --checkpoint "<name>" --unscripted --live   # held-out: only at a checkpoint
```

A report is never overwritten. A second run on the same day gets `-2`, and a `--only`, `--live` or `--unscripted` run says so in its name.

## Changes to this protocol

- 2026-09-30: This version. It gathers the rules added while the benchmark was built into the sections above. Every later change is a dated entry below.
- 2026-09-30: **Scoring: a read must say it reached its end.** Every read now records how it ended (`completion`: traversed, partial or unknown, and why).
  - A read that says nothing about its end is `unknown`, and its tile says it may not be every record. Connector code that returns records without saying it read them all is the usual case.
  - A read narrowed by the API's own filter, or answered by the API's own count, is scored complete only when nothing says it may be short. An `unknown` read is therefore scored as flagged, not complete.
  - A read compared with how many records the provider really holds (read / held) is scored exactly as before.
  - Prompted by a review of how reads are executed, not by any held-out outcome.
- 2026-09-30: **An exposure, recorded.**
  - **What was seen.** A search of the source for the paging type `NextPage` did not leave the held-out files out. It printed lines of `heldout-2026-09-28.ts` that mention `hasNextPage`, the page flag of GraphQL's Relay connections. Most were shopwell's, a dev provider since checkpoint 4. Two (a schema field and a line of a handler) did not show which provider they belong to.
  - **What was built from it:** nothing. Relay paging was already supported and already tried by the check.
  - Searches of the source leave `heldout*` out again.
- 2026-10-01: **Scoring: a read settled to the record the request names.** Some endpoints need an input another list supplies, such as a workspace's tasks. The check settles that input to the one record the request names ("the Marketing workspace"), or reads every record's. A read settled to one named record holds fewer records than the collection by design, like a read narrowed by the API's own filter. It is scored complete on the same terms: nothing cut it short, nothing says it may be short, and any count the API gave matches. The answer key still decides whether it read the right records. Prompted by work on inputs another list supplies, and by the dev provider `workroom`, written for it.
- 2026-10-02: **Checkpoint 6 notes.**
  - **Dev was fixed after its own run.** The dev split ran first (30 of 32). Four generic gaps it showed were then fixed:
    - templates declared twice under one name;
    - a path named inside a whole address in the documentation;
    - an input the API's own answer says is required;
    - a request body that is not JSON.
    Twofold and chargebolt were re-run after the fixes, live. The real and held-out splits ran after the fixes.
  - **Trackwell is still held out.** The maintainer chose to measure it first, not study it. Unscripted, it again read 50 of 264 and said nothing. Whether to study it is the maintainer's decision.
- 2026-10-02: **Scoring: a read carried on past its own limit.** A tile reads at most a page ceiling's worth of pages, or a connector's runs' worth. Past that, the product now carries the read on in the background, from where it stopped, and the tile gets the whole answer when the read reaches its end.
  - The scorer does the same. A read that stops at its own limit and says where it stopped is carried on through the product's own `LongReads`, and the whole answer is scored.
  - A read that cannot be carried on is scored as before.
  - Each report now records how the scored read ended (`ended`), and anything carrying it on met.
  - Prompted by work on reads past a tile's limits, and by the dev provider `longhaul`, written for it. Payrail's checkpoint results stopped at the page ceiling. Its later results will partly measure this work.
- 2026-10-03: **Checkpoint 7 notes.**
  - Long reads, the check queue, the documentation renderer and several workspaces on one server were built between checkpoints 6 and 7. No held-out failure was studied.
  - **The benchmark draws pages where Chromium is installed.** Discovery in the benchmark has the documentation renderer, as the product does. Playwright's Chromium was installed on the benchmark's machine for this checkpoint. The benchmark never downloads it: where it is not installed, a scenario that needs it (`needs: "browser"`) is skipped and said, and any other page drawn by scripts stops as before.
  - Harborline (dev) missed once, unscripted, when its model-written connector code failed; run again, it was correct. Reported as the run's result, with the re-run noted.
- 2026-10-03: **Trackwell studied, and moved to dev.** By the maintainer's decision after checkpoint 7 (it read 50 of 264 and said nothing, at checkpoints 5, 6 and 7), trackwell's files were read and it is now a dev provider. The held-out set is 11 until a separate author who never reads the integration code writes a replacement. The gaps it showed, each fixed generically:
  - an answer that said there was more (`isLast: false`, a next token) was called complete; it is now partial, and said;
  - a token handed back under a parameter's own name was never tried as the cursor;
  - records that came back as ids alone were never asked for their fields, though the documentation said how;
  - fields inside an object the specification leaves open were never described, and the values a request can name came from the first page only;
  - the brief's roster gave its places to objects and dropped categories called "name". Fields whose values the request names now come first. The brief is sent back once where a value sits on another field, or a word of the request is a value nothing narrows by. A narrowing by a value no record matches now says so on the tile.
- 2026-10-03: **Scoring: a read that went to its end over more records than the objective counts.** Trackwell's read takes every issue, and the question is about one project's. A read whose completion is `traversed`, cut short by nothing and flagged by nothing, holding at least as many records as the objective counts, holds every record asked about; it is scored complete. Whether the widget narrowed to the right ones is the answer key's to say, as before.
- 2026-10-03: **After trackwell's study, measured.**
  - Trackwell unscripted: correct in each of five live runs (26 of 26, every issue read).
  - **The scripted path** now also matches an endpoint whose path ends with it, where only one does: a path written against an address that holds more of it (`/search/jql` under `…/rest/api/3`). Trackwell's scripted run then needs a model's judgment, a query restriction for its search, so it stops without scripted answers, as shopwell, chargebolt and cashloom do.
  - **A regression, caught by the dev run and fixed.** The brief's new feedback sent cashloom's answer back because "refunded" is also a status value, though it already narrowed by a field named for it. A word the answer covers in a field's own name is now taken as said. Cashloom is correct again in two live runs.
  - Dev unscripted after the fix: chargebolt's model-written connector stopped short once, flagged, which is the run-to-run variance recorded at checkpoint 6.
- 2026-10-03: **Trackwell's replacement, written.** A separate author who never read the integration code wrote one held-out provider, `staffnest` (`providers/heldout-2026-10-03.ts`), and wired it in. Its reference connection proves both of its answer keys. The held-out set is 12 again.
