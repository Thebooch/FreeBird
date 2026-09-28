# Unscripted choice: first measurements

The owner's checkpoint 1 decision was **measure first**. This file records what the unscripted path found, in order, each finding written before anything was changed in response to it.

The **unscripted path** (`--unscripted`, `apps/server/src/bench/brief-choice.ts`) is the product's own route from a request to a widget:
1. describe the API's record types (the `entity` pass);
2. write a brief over them (the widget task);
3. compile it (`compileBrief`).

The integration loop then settles whichever endpoint the compiled widget reads. The scorer and answer keys are the same as for scripted runs.

## 1. Smoke run — dev, three providers, live (`2026-09-28-dev-agent-only-taskpad-ledgerly-searchy-unscripted-live`)

All four scenarios stopped at `describe`, with no model call made: *"No record types could be described: 0 resource(s)."*

**Cause: a rule in the product, not in the benchmark.** A top-level collection becomes a resource (and so can become a record type) only when the API also has a by-id endpoint for it (`/tasks` plus `/tasks/{id}`). A collection nested under a parent needs none (`resource.ts`, `deriveResourceGraph`). So a collection offered only as a list — a search, an export, a report, or simply an API without by-id reads — can never be described, and the brief path can never reach it. The rule dates from the first commit, and no test asserts it.

Every provider in the benchmark is list-only: they were written for scripted choices, which never needed a record type. A real API usually has by-id reads for its main records, so the effect here is larger than it would be on a real API — but searches, exports and reports have none anywhere.

**Changed in response:** top-level collections with no by-id endpoint now become resources, derived after every other resource so that no existing id moves (`resource.ts`, with a test). The next finding is after this change.

## 2. Smoke run again — same three providers, live (`…-unscripted-live-2`)

The model's **choice was right every time**. The briefs it wrote:

| Scenario | Brief |
|---|---|
| ledgerly, invoice count | invoices, `measure`, count |
| ledgerly, open total | invoices, `measure`, sum, filter `status = open` |
| taskpad, done count | tasks, `measure`, count, filter `status = done` |
| searchy, shipped count | orders, `measure`, count, filter `status = shipped` |

Every failure came after the choice, in deterministic product code:

| Scenario | Result | Cause |
|---|---|---|
| ledgerly count, searchy count | **1 record read, of 1,234 and 140 — incomplete, silently** | A widget compiled from a brief always reads records at `$`, the top of the response. These endpoints wrap their records (`$.data`, `$.orders`), so the wrapper is read as one record. A board does exactly the same (`executeWidget` over the raw body). Real APIs tried so far answer with a bare list, which is why this went unnoticed. The observation step (`wrapperOf`) handles a record wrapped inside each row, not a list wrapped under a key. |
| taskpad done count | 57, where 25 is right | A `measure` or `compare` widget drops the brief's filter values without a word. Filters become strips only on a `records` widget, and a single number has nothing to narrow it. |
| ledgerly open total | Did not compile: "A sum needs a field to add up" | The model asked for a sum and did not name the field. `writeBrief` accepted that brief instead of sending it back, as its schema says it requires. |

These are defects in the path every widget built from a request takes, not gaps in capability. Each makes a dashboard number wrong, one of them silently.

**Changed in response:**
- a compiled widget reads records at its endpoint's own path (`CompileBriefInput.rowsPathOf`, passed by all six callers);
- a narrowing on a number or a comparison is applied before the number is taken, matched without regard to case, and said on the widget;
- `writeBrief` sends a sum that names no field back once.

Each has a test.

## 3. The whole dev set, unscripted, live (`2026-09-28-dev-agent-unscripted-1-unscripted-live`)

**6 of 16 correct** (ledgerly ×2, taskpad, emptyco, searchy, oauthco), against 0 of 4 before the changes above. Nothing was silently incomplete.

| Scenario | Result | Cause | Kind |
|---|---|---|---|
| rentroll | 0 of 100 | Each lease arrives wrapped (`{ lease: { … } }`). The product re-roots a record type after observing its first read (`observeConnection` → `recompileReadings`); the benchmark's path did not run that step. | **Benchmark fidelity** |
| keyring | 90, where 13 is right | The model wrote the field's label ("VIP") where its path belongs; the filter was dropped as naming no field. | Defect: the roster shows `label (path)` and the brief took the label |
| stampede | Did not compile | Same: "total amount" (a label) as the field to sum. | Same defect |
| multicur | 0, where 90,112 is right | Narrowed to "US dollars", the user's words; the data says `USD`. The record type does not know the values its fields hold (`BriefField.values` is empty on every field). | Capability: a field's real values |
| filterly | 131, where 56 is right | "Closed in 2026": a brief has no time window, so the model built a count of everything. | Capability: date windows in a brief (track E) |
| billhub | No brief | Asked twice, the model named no field to add up. Not yet diagnosed: `amount` is a declared number. | To diagnose |
| prosebook ×2 | No record types | Documented in prose: no declared fields, so nothing to describe. | Capability: record types from a read, not only from declarations |
| sessionly, vaultbank | No record types | NDJSON and CSV: no declared fields. | Same |

The choosing itself was sound wherever it had something to choose from: every brief named the right record type and intent, and every narrowing named the right field (by label twice).

**Changed in response:**
- The benchmark's path now observes the first read and recompiles, as the product does (`observeFirstRead`).
- A field the model names by its label is resolved to its path where exactly one field has that label (`writeBrief`).

## 4. The whole dev set again (`2026-09-28-dev-agent-unscripted-1-unscripted-live-2`)

**8 of 16 correct.**
- **Rentroll** now passes: its first read was observed, the record type moved inside `lease`, and the widget was rebuilt.
- **Multicur and billhub** also passed, though nothing changed that bears on them. This time the model narrowed to `USD` and named the field to add up. That is run-to-run variance in the model, and it is why one run is not a rate.
- **Ledgerly's open total** failed this time. Last run it passed with the same code: the model named "amount due", a field that does not exist.

| Scenario | Result | Cause |
|---|---|---|
| ledgerly open total, stampede | Did not compile | The model named a field that is not on the roster ("amount due", "total amount"). The roster offers a field to add up only where the description tagged it as money or a quantity (`semantic`), so an untagged number is never offered and the model guesses a name for it. |
| keyring | 90, where 13 is right | The roster offers fields to narrow by only from the record kind's recipe. A true/false flag like `vip` was never offered, so the model had no way to ask for "the VIP ones", and built a count of all contacts. |
| filterly | 131, where 56 is right | No time window in a brief (unchanged). |
| prosebook ×2, sessionly, vaultbank | No record types | No declared fields (unchanged). |

**Changed in response (`briefCandidates`, `writeBrief`, with tests):**
- the roster also offers true/false flags and fields with a known set of values to narrow by, after the recipe's own, and numbers that are not identities to add up, after the tagged ones (up to 5 and 3);
- a brief naming a field in words that are neither a path nor any field's label goes back once, with the reason.

## 5. The whole dev set again (`…-unscripted-live-3`), then after one more fix (`…-unscripted-live-4`)

**9 of 16, then 11 of 16.**
- Stampede's total and ledgerly's open total now pass: the model was sent back once, or offered the field it needed.
- Keyring failed in run 3 in a new way. The model narrowed the `vip` flag to the value "VIP", and a true/false field compared as text matched nothing (0 where 13 is right). **Changed in response:** a flag narrowed by any word means "where it is set", unless the words say no; the roster shows a flag's values as `true / false`. Keyring then passed.
- Filterly passed in run 4, and it is not the time-window test it looked like. Its endpoint's documented default already limits it to this year, so counting tickets with the `closed` flag set is right. **No scenario in the dev set needs a time window in a brief.**

## Where the dev set stands

With every model call live, the product chooses and computes correctly on **11 of 16** dev scenarios, from the plain request alone. The last full run with the same scenarios scripted was 16 of 16.

| Remaining failure | Scenarios | Missing capability | Track |
|---|---|---|---|
| No record types: the documentation declares no fields (prose docs, NDJSON, CSV) | prosebook ×2, sessionly, vaultbank | Describing record types from a read, not only from declared fields | C (discovery fidelity), with D |
| A narrowing the model does not make, or makes in the user's words ("US dollars" where the data says `USD`) | multicur | A field's real values, and offering plain text fields to narrow by, from what a read showed | C / E |
| (Not yet measured) a time window: "closed in July", "this quarter" | none in the set | Date windows in a brief (metric contracts) | E |

Along the way the measurement found, and the product now has fixed, each with a test:
- **list-only collections unreachable** — no by-id endpoint, so no record type;
- **wrapped lists read as one record — silently**;
- **narrowing dropped from a number**;
- **a flag compared as text**;
- **no field offered to add up**, and **fields named by label or description**;
- **a sum naming no field accepted**.

All of these were in the path every widget built from a request takes. The first two affected any API outside the three it had been run on; the second is the kind the benchmark exists to catch, a wrong number with nothing on the tile.

**What the product change means for existing boards.** A number or chart widget whose brief narrowed by values used to ignore the narrowing. When such a widget is next recompiled (its settings changed, or its record type observed), it will count only what the narrowing names, and say so. That is a correction, and it will change numbers people have seen.

**Variance.** Model answers differ between runs with no change in the code. Multicur and billhub each failed in one run and passed in another. A single run is a measurement, not a rate.
