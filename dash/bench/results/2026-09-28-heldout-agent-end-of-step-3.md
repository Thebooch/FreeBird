# Benchmark: agent, heldout split — end of step 3

- Date: 2026-09-28T02:32:24.675Z
- Choices: scripted (measures mechanics, not judgment — see PROTOCOL.md)
- Model: scripted per provider

| | Count |
|---|---|
| Scenarios | 5 |
| Task success | 4 |
| Setup done | 4 |
| With a technical intervention | 1 |
| Retrieval ok | 4 |
| Complete | 4 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 4 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stockroom | low-stock | done | 0 | ok | complete | 260 / 260 | correct | 37 / 37 | 21 | 0 |  |
| helpline | august-urgent | done | 0 | ok | complete | 415 / 415 | correct | 29 / 29 | 14 | 0 |  |
| vaultbank | july-debits | stopped:integrate | 1 | none | n/a | — / 640 | n/a | — / 123953.4 | 0 | 0 | The "signed" sign-in scheme uses signed requests (AWS Signature, HMAC), which is not supported yet. Requests cannot be signed yet. |
| quotient | won-total | done | 0 | ok | complete | 230 / 230 | correct | 2225110.98 / 2225110.98 | 18 | 0 |  |
| ledgerline | revenue-entries | done | 0 | ok | complete | 380 / 380 | correct | 152 / 152 | 16 | 0 |  |
