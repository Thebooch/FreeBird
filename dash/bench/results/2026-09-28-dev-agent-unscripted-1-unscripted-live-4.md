# Benchmark: agent, dev split — unscripted-1

- Date: 2026-09-28T21:55:45.918Z
- Choices: the integrator's own
- Model: gpt-5.6-terra

| | Count |
|---|---|
| Scenarios | 16 |
| Task success | 11 |
| Setup done | 12 |
| With a technical intervention | 0 |
| Retrieval ok | 12 |
| Complete | 12 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 11 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ledgerly | invoice-count | done | 0 | ok | complete | 1234 / 1234 | correct | 1234 / 1234 | 43 | 2 |  |
| ledgerly | open-total | done | 0 | ok | complete | 1234 / 1234 | correct | 879419.12 / 879419.12 | 43 | 2 |  |
| taskpad | done-count | done | 0 | ok | complete | 57 / 57 | correct | 25 / 25 | 3 | 2 |  |
| rentroll | active-leases | done | 0 | ok | complete | 180 / 180 | correct | 100 / 100 | 15 | 2 |  |
| emptyco | customer-count | done | 0 | ok | complete | 0 / 0 | correct | 0 / 0 | 3 | 2 |  |
| prosebook | book-count | stopped:describe | 0 | none | n/a | — / 42 | n/a | — / 42 | 0 | 1 | No record types could be described: 0 resource(s), none with fields the documentation declares. |
| prosebook | history-pages | stopped:describe | 0 | none | n/a | — / 42 | n/a | — / 5220 | 0 | 1 | No record types could be described: 0 resource(s), none with fields the documentation declares. |
| multicur | usd-received | done | 0 | ok | complete | 300 / 300 | wrong | 136626.59 / 90112.26 | 16 | 2 |  |
| billhub | unpaid-total | done | 0 | ok | complete | 64 / 64 | correct | 26437.5 / 26437.5 | 4 | 2 |  |
| keyring | vip-count | done | 0 | ok | complete | 90 / 90 | correct | 13 / 13 | 4 | 2 |  |
| searchy | shipped-count | done | 0 | ok | complete | 140 / 140 | correct | 67 / 67 | 21 | 2 |  |
| oauthco | active-projects | done | 0 | ok | complete | 120 / 120 | correct | 83 / 83 | 35 | 2 |  |
| filterly | closed-2026 | done | 0 | ok | complete | 131 / 131 | correct | 56 / 56 | 3 | 2 |  |
| sessionly | open-tickets | stopped:describe | 0 | none | n/a | — / 230 | n/a | — / 59 | 0 | 0 | No record types could be described: 0 resource(s), none with fields the documentation declares. |
| stampede | paid-total | done | 0 | ok | complete | 180 / 180 | correct | 17318.28 / 17318.28 | 28 | 5 |  |
| vaultbank | july-debits | stopped:describe | 0 | none | n/a | — / 640 | n/a | — / 123953.4 | 0 | 0 | No record types could be described: 1 resource(s), none with fields the documentation declares. |
