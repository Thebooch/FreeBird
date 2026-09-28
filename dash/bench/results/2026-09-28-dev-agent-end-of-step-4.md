# Benchmark: agent, dev split — end-of-step-4

- Date: 2026-09-28T15:30:34.569Z
- Choices: scripted (measures mechanics, not judgment — see PROTOCOL.md)
- Model: scripted per provider

| | Count |
|---|---|
| Scenarios | 15 |
| Task success | 15 |
| Setup done | 15 |
| With a technical intervention | 0 |
| Retrieval ok | 15 |
| Complete | 15 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 15 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ledgerly | invoice-count | done | 0 | ok | complete | 1234 / 1234 | correct | 1234 / 1234 | 30 | 0 |  |
| ledgerly | open-total | done | 0 | ok | complete | 1234 / 1234 | correct | 879419.12 / 879419.12 | 30 | 0 |  |
| taskpad | done-count | done | 0 | ok | complete | 57 / 57 | correct | 25 / 25 | 2 | 0 |  |
| rentroll | active-leases | done | 0 | ok | complete | 180 / 180 | correct | 100 / 100 | 11 | 0 |  |
| emptyco | customer-count | done | 0 | ok | complete | 0 / 0 | correct | 0 / 0 | 2 | 0 |  |
| prosebook | book-count | done | 0 | ok | complete | 42 / 42 | correct | 42 / 42 | 2 | 1 |  |
| prosebook | history-pages | done | 0 | ok | complete | 42 / 42 | correct | 5220 / 5220 | 2 | 1 |  |
| multicur | usd-received | done | 0 | ok | complete | 300 / 300 | correct | 90112.26 / 90112.26 | 12 | 0 |  |
| billhub | unpaid-total | done | 0 | ok | complete | 64 / 64 | correct | 26437.5 / 26437.5 | 3 | 0 |  |
| keyring | vip-count | done | 0 | ok | complete | 90 / 90 | correct | 13 / 13 | 3 | 0 |  |
| searchy | shipped-count | done | 0 | ok | complete | 140 / 140 | correct | 67 / 67 | 16 | 0 |  |
| oauthco | active-projects | done | 0 | ok | complete | 120 / 120 | correct | 83 / 83 | 28 | 0 |  |
| filterly | closed-2026 | done | 0 | ok | complete | 131 / 131 | correct | 56 / 56 | 2 | 0 |  |
| sessionly | open-tickets | done | 0 | ok | complete | 230 / 230 | correct | 59 / 59 | 8 | 1 |  |
| stampede | paid-total | done | 0 | ok | complete | 180 / 180 | correct | 17318.28 / 17318.28 | 15 | 2 |  |
