# Benchmark: agent, heldout split — end-of-step-4-after-fix

- Date: 2026-09-28T15:42:07.580Z
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
| quotient | won-total | done | 0 | ok | complete | 230 / 230 | correct | 2225110.98 / 2225110.98 | 18 | 0 |  |
| ledgerline | revenue-entries | done | 0 | ok | complete | 380 / 380 | correct | 152 / 152 | 16 | 0 |  |
| harborline | august-delivered-weight | stopped:integrate | 1 | none | n/a | — / 470 | n/a | — / 31939.5 | 0 | 2 | The "token" sign-in scheme uses signing in for a session token, which is only partly supported. Client credentials are supported directly. Any other login for a session token is done by connector code: the server sends the login and keeps the token, and the code never sees either. |
