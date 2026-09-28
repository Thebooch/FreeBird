# Measurement 1: choosing, and real APIs

The owner's decision at checkpoint 1 was **measure first**: measure the two things the evidence did not cover — choosing what to read, and real APIs — then order step 6's tracks by what those show. This is that measurement. The finding-by-finding record of the unscripted path is `unscripted-1.md`.

## What was built to measure

- **The unscripted path** (`pnpm bench --unscripted --live`). The integrator is given only the request, and goes the product's own way: describe the record types → write a brief → compile it → settle the endpoint with the integration loop → observe the first read and rebuild. It is scored against the same answer keys as the scripted path.
- **A real split** (`pnpm bench --split real --live`). Public APIs that need no key (the owner's choice): DummyJSON (products, carts) and JSONPlaceholder (to-dos).
  - They are reached over the network through the server's own SSRF guard, restricted to each provider's hosts.
  - Answer keys are computed by plain reference code from a snapshot of the full data (`real/snapshot.mts`). Before scoring, the snapshot is compared with the live API, so a changed API is reported as a stale key rather than mis-scored.

## Results (every model call live, `gpt-5.6-terra`)

| Run | Choices | Scenarios | Correct | Silently incomplete |
|---|---|---|---|---|
| Dev, first unscripted smoke | model | 4 | 0 | — |
| Dev, after the fixes below | model | 16 | **11** | 0 |
| Dev, scripted (after checkpoint 1) | scripted | 16 | 16 | 0 |
| Real, scripted | scripted | 5 | **2** | 0 |
| Real, unscripted | model | 5 | **0** | 0 |

Held-out: the separate session's providers are written but not yet reported in, so they are not wired in or run.

**Where it chose, it chose well.** In every unscripted scenario that got as far as a brief, the model named the right record type, the right intent (a number, not a list) and the right narrowing field. The failures were in what surrounds the choice.

## What the measurement fixed on the way

Each was a defect in the path every widget built from a request takes, found by this measurement and fixed with a test (`unscripted-1.md`):
- a collection with no by-id endpoint could never become a record type;
- **a widget over a list wrapped under a key read the wrapper as one record, silently** (1,234 invoices counted as 1);
- a number or chart ignored the request's narrowing;
- a true/false flag was compared as text;
- the roster never offered untagged numbers to add up, or flags to narrow by;
- a field named by its label or described in words compiled into nothing, as did a sum naming no field.

## Failures that remain, by missing capability

| # | Missing capability | Evidence | Scenarios | Track |
|---|---|---|---|---|
| 1 | **Record types for an API whose documentation declares no fields.** The prose importer makes no resources and no fields at all, and CSV/NDJSON answers declare none. Nothing is described, so no request can reach the data, even where a scripted read of the same endpoint is correct. | All 5 real; prosebook ×2, sessionly, vaultbank | 9 | **C** (discovery fidelity): resources for prose endpoints, and fields from what the integration check's first read shows |
| 2 | **A date basis for a total.** The prose importer took DummyJSON's documented `modifiedAfter` filter as the connection's dashboard time window, so every read of the catalogue asked only for products modified in the last 30 days. The API honestly answered "33", and the count was wrong. | Real products ×3 (scripted) | 3 | **E** (metric contracts: date basis) |
| 3 | **Comparisons and time windows in a brief** ("cost more than $100", "closed in July"). A brief can narrow by values, not by a range. | Real "over-100", once #1 is fixed; no dev scenario yet | 1+ | **E** |
| 4 | **A field's real values**, so a narrowing is written in the data's terms ("USD", not "US dollars"), and plain text fields are offered to narrow by. | multicur (varies by run) | 1 | **C / E** |

No measured failure yet in: A (formats beyond what connector code handles), B (auth breadth), D (completeness and history, beyond #1), F (private networks), G (hosting) or H (drift).

## Proposed order for step 6

1. **C, first slice: record types from the endpoints the integration check reads.**
   - Resources for prose-documented endpoints.
   - Fields and a rows path taken from the check's first real read wherever the documentation declares none — prose docs, CSV, NDJSON, connector-served endpoints.
   - This unblocks 9 of the 21 unscripted scenarios, all five real ones among them.
2. **E, first slice: date basis and ranges.**
   - A time filter the importer finds is offered, not installed as every read's window.
   - A brief can say "between", "more than" and "in July".
3. **C/E: field values.** Values observed in reads (and declared enums, which the importer does not yet capture), offered to the brief.
4. **Held-out and real again.** The separate session's held-out providers, and the real split, re-run after 1–3, to see what those change and what is next.

Then:
- **D** (background full reads, history), **B** (auth breadth, built-in signers), **H** (drift), **A** (declarative formats) — in the order the next measurement shows.
- **G** (hosting) and **F** (private networks) — until a deployment needs them, or the owner says otherwise.

## What this does not show

- **Variance.** One model, one run per scenario. Model answers differ between runs with no change in the code (multicur and billhub each passed once and failed once).
- **Authorship.** The real split is three small, static demo APIs chosen for being keyless — not business SaaS. The dev set is synthetic and written in this project.
- **Cost.** Choosing adds 2 model calls per request (describe, brief), about $0.005–$0.02 each.

---

## Track C, first slice: record types for endpoints whose documentation declares no fields (owner's go-ahead, 2026-09-28)

Built:
- **Resources for prose documentation.** The prose importer derives resources from the paths it names, as the OpenAPI importer does.
- **Line-per-record answers are collections.** An endpoint answering in CSV or NDJSON is a collection (`archetype: list`), whatever its schema says.
- **The check reports what it read.** For every endpoint it read, the integration check reports where the records are and each field's name and kind — never values (`integrate/observed.ts`).
- **The server records it and describes, by itself.** Observed fields go onto the catalog entry's endpoints that declared none (`fieldsFrom: "observed"`), and the record types that can now be described are described then, with nothing to press (`describeMissingRecords`, factored out of the describe route).
- **A read can show a collection.** An endpoint a read showed answering with many records becomes a resource, on the entry and on its connections, whatever its path suggests.
- **Nothing readable, sign-in needs code.** When nothing is readable as documented and the sign-in needs connector code, the check starts on the first collection the documentation offers.
- **Connector-served endpoints skip the id check.** The compiler's "needs an id" check does not apply to an endpoint connector code serves, since the code supplies its own ids.

The unscripted procedure now runs the product's own first check before choosing, as the product does once a key is saved (PROTOCOL.md).

| Run | Before | After |
|---|---|---|
| Dev, unscripted (`…-trackc-1-final-unscripted-live`) | 11 of 16; 4 stopped before choosing | **13 of 16; none stopped — every scenario read completely** |
| Real, unscripted (`2026-09-28-real-agent-trackc-1-final-unscripted-live`) | 0 of 5; all stopped before choosing | **2 of 5; none stopped** |
| Dev, scripted (regression) | 16 of 16 | 16 of 16 |

**Sessionly, unscripted, end to end:**
1. NDJSON imported as a collection.
2. The check found a sign-in only code can do, and a live model wrote login connector code.
3. The two credentials were asked for.
4. The code read every page in the sandbox, and the fields were observed.
5. The record type was described, the brief chose it, and the count was right — from "How many tickets are open?" alone.

**What still fails:**

| Scenario | Why | Track |
|---|---|---|
| dummyjson-products ×3 (real) | The prose importer installed `modifiedAfter` as every read's time window, so 30 of 194 were read — and said so on the tile | E |
| vaultbank | All 640 transactions read; the brief cannot say "debits, in July" | E |
| multicur | The narrowing is not made, or is made in the user's words | C / E (field values) |
| filterly | Passed in the previous run; the model narrowed differently this time | variance |

**Every failing scenario now reads all its records.** What is left is saying which of them to count and when — the date basis, ranges, and values of track E. That is the next slice.
