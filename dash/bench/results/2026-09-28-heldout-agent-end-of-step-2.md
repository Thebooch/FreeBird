# Benchmark: agent, heldout split — end of step 2

- Date: 2026-09-28T01:06:04.012Z
- Choices: scripted (measures mechanics, not judgment — see PROTOCOL.md)
- Model: scripted per provider

| | Count |
|---|---|
| Scenarios | 3 |
| Task success | 2 |
| Setup done | 2 |
| With a technical intervention | 1 |
| Retrieval ok | 2 |
| Complete | 2 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 2 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stockroom | low-stock | done | 0 | ok | complete | 260 / 260 | correct | 37 / 37 | 21 | 0 |  |
| helpline | august-urgent | done | 0 | ok | complete | 415 / 415 | correct | 29 / 29 | 14 | 0 |  |
| vaultbank | july-debits | stopped:integrate | 1 | none | n/a | — / 640 | n/a | — / 123953.4 | 0 | 2 | The API refused the request. |
