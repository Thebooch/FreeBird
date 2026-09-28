# Benchmark: agent, heldout split — checkpoint-1-after-fixes

- Date: 2026-09-28T16:33:11.820Z
- Choices: scripted (measures mechanics, not judgment — see PROTOCOL.md)
- Model: gpt-5.6-terra

| | Count |
|---|---|
| Scenarios | 5 |
| Task success | 5 |
| Setup done | 5 |
| With a technical intervention | 0 |
| Retrieval ok | 5 |
| Complete | 5 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 5 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stockroom | low-stock | done | 0 | ok | complete | 260 / 260 | correct | 37 / 37 | 21 | 0 |  |
| helpline | august-urgent | done | 0 | ok | complete | 415 / 415 | correct | 29 / 29 | 14 | 0 |  |
| quotient | won-total | done | 0 | ok | complete | 230 / 230 | correct | 2225110.98 / 2225110.98 | 18 | 0 |  |
| ledgerline | revenue-entries | done | 0 | ok | complete | 380 / 380 | correct | 152 / 152 | 16 | 0 |  |
| harborline | august-delivered-weight | done | 0 | ok | complete | 470 / 470 | correct | 31939.5 / 31939.5 | 11 | 2 |  |
