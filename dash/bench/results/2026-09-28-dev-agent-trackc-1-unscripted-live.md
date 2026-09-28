# Benchmark: agent, dev split — trackc-1

- Date: 2026-09-28T23:30:48.730Z
- Choices: the integrator's own
- Model: gpt-5.6-terra

| | Count |
|---|---|
| Scenarios | 16 |
| Task success | 13 |
| Setup done | 14 |
| With a technical intervention | 0 |
| Retrieval ok | 14 |
| Complete | 14 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 13 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ledgerly | invoice-count | done | 0 | ok | complete | 1234 / 1234 | correct | 1234 / 1234 | 44 | 2 |  |
| ledgerly | open-total | done | 0 | ok | complete | 1234 / 1234 | correct | 879419.12 / 879419.12 | 44 | 2 |  |
| taskpad | done-count | done | 0 | ok | complete | 57 / 57 | correct | 25 / 25 | 4 | 2 |  |
| rentroll | active-leases | done | 0 | ok | complete | 180 / 180 | correct | 100 / 100 | 16 | 2 |  |
| emptyco | customer-count | done | 0 | ok | complete | 0 / 0 | correct | 0 / 0 | 4 | 2 |  |
| prosebook | book-count | done | 0 | ok | complete | 42 / 42 | correct | 42 / 42 | 4 | 3 |  |
| prosebook | history-pages | done | 0 | ok | complete | 42 / 42 | correct | 5220 / 5220 | 5 | 4 |  |
| multicur | usd-received | done | 0 | ok | complete | 300 / 300 | wrong | 136626.59 / 90112.26 | 17 | 2 |  |
| billhub | unpaid-total | done | 0 | ok | complete | 64 / 64 | correct | 26437.5 / 26437.5 | 5 | 2 |  |
| keyring | vip-count | done | 0 | ok | complete | 90 / 90 | correct | 13 / 13 | 5 | 2 |  |
| searchy | shipped-count | done | 0 | ok | complete | 140 / 140 | correct | 67 / 67 | 22 | 2 |  |
| oauthco | active-projects | done | 0 | ok | complete | 120 / 120 | correct | 83 / 83 | 38 | 2 |  |
| filterly | closed-2026 | done | 0 | ok | complete | 131 / 131 | correct | 56 / 56 | 4 | 2 |  |
| sessionly | open-tickets | stopped:describe | 0 | none | n/a | — / 230 | n/a | — / 59 | 8 | 1 | No record types could be described: 0 resource(s), none with fields the documentation declares. |
| stampede | paid-total | done | 0 | ok | complete | 180 / 180 | correct | 17318.28 / 17318.28 | 37 | 4 |  |
| vaultbank | july-debits | stopped:describe | 0 | none | n/a | — / 640 | n/a | — / 123953.4 | 5 | 2 | No record types could be described: 1 resource(s), none with fields the documentation declares. |
