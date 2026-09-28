# Benchmark: baseline, dev split

- Date: 2026-09-28T01:06:00.627Z
- Choices: scripted (measures mechanics, not judgment — see PROTOCOL.md)
- Model: scripted per provider

| | Count |
|---|---|
| Scenarios | 10 |
| Task success | 3 |
| Setup done | 10 |
| With a technical intervention | 0 |
| Retrieval ok | 7 |
| Complete | 3 |
| Incomplete, and said so | 4 |
| Incomplete, silently | 0 |
| Metric correct | 3 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ledgerly | invoice-count | done | 0 | ok | incomplete-flagged | 25 / 1234 | wrong | 25 / 1234 | 1 | 0 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| ledgerly | open-total | done | 0 | ok | incomplete-flagged | 25 / 1234 | wrong | 17709.42 / 879419.12 | 1 | 0 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| taskpad | done-count | done | 0 | error | n/a | — / 57 | n/a | — / 25 | 1 | 0 | 502: Taskpad returned an error (400). |
| rentroll | active-leases | done | 0 | ok | incomplete-flagged | 50 / 180 | wrong | 34 / 100 | 1 | 0 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| emptyco | customer-count | done | 0 | ok | complete | 0 / 0 | correct | 0 / 0 | 1 | 0 |  |
| prosebook | book-count | done | 0 | ok | complete | 42 / 42 | correct | 42 / 42 | 1 | 1 |  |
| prosebook | history-pages | done | 0 | ok | complete | 42 / 42 | correct | 5220 / 5220 | 1 | 1 |  |
| multicur | usd-received | done | 0 | ok | incomplete-flagged | 20 / 300 | wrong | 3591.24 / 90112.26 | 1 | 0 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| billhub | unpaid-total | done | 0 | error | n/a | — / 64 | n/a | — / 26437.5 | 1 | 0 | 502: Billhub returned an error (404). |
| keyring | vip-count | done | 0 | error | n/a | — / 90 | n/a | — / 13 | 1 | 0 | 401: Keyring CRM rejected the key. It may be wrong, expired, or revoked. |
