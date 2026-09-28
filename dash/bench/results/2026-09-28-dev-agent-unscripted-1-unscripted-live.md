# Benchmark: agent, dev split — unscripted-1

- Date: 2026-09-28T21:30:30.127Z
- Choices: the integrator's own
- Model: gpt-5.6-terra

| | Count |
|---|---|
| Scenarios | 16 |
| Task success | 6 |
| Setup done | 10 |
| With a technical intervention | 0 |
| Retrieval ok | 10 |
| Complete | 10 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 6 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ledgerly | invoice-count | done | 0 | ok | complete | 1234 / 1234 | correct | 1234 / 1234 | 30 | 2 |  |
| ledgerly | open-total | done | 0 | ok | complete | 1234 / 1234 | correct | 879419.12 / 879419.12 | 30 | 3 |  |
| taskpad | done-count | done | 0 | ok | complete | 57 / 57 | correct | 25 / 25 | 2 | 2 |  |
| rentroll | active-leases | done | 0 | ok | complete | 180 / 180 | wrong | 0 / 100 | 11 | 2 |  |
| emptyco | customer-count | done | 0 | ok | complete | 0 / 0 | correct | 0 / 0 | 2 | 2 |  |
| prosebook | book-count | stopped:describe | 0 | none | n/a | — / 42 | n/a | — / 42 | 0 | 1 | No record types could be described: 0 resource(s), none with fields the documentation declares. |
| prosebook | history-pages | stopped:describe | 0 | none | n/a | — / 42 | n/a | — / 5220 | 0 | 1 | No record types could be described: 0 resource(s), none with fields the documentation declares. |
| multicur | usd-received | done | 0 | ok | complete | 300 / 300 | wrong | 0 / 90112.26 | 12 | 2 |  |
| billhub | unpaid-total | stopped:choose | 0 | none | n/a | — / 64 | n/a | — / 26437.5 | 0 | 3 | the model did not write a usable brief: measureAgg is "sum" but measureField is missing: name the number to add up, copied from the record type's fields. |
| keyring | vip-count | done | 0 | ok | complete | 90 / 90 | wrong | 90 / 13 | 3 | 2 |  |
| searchy | shipped-count | done | 0 | ok | complete | 140 / 140 | correct | 67 / 67 | 16 | 2 |  |
| oauthco | active-projects | done | 0 | ok | complete | 120 / 120 | correct | 83 / 83 | 28 | 2 |  |
| filterly | closed-2026 | done | 0 | ok | complete | 131 / 131 | wrong | 131 / 56 | 2 | 2 |  |
| sessionly | open-tickets | stopped:describe | 0 | none | n/a | — / 230 | n/a | — / 59 | 0 | 0 | No record types could be described: 0 resource(s), none with fields the documentation declares. |
| stampede | paid-total | stopped:build | 0 | none | n/a | — / 180 | n/a | — / 17318.28 | 0 | 2 | The brief did not compile: "total amount" is not a field Order has, so it cannot be totalled. |
| vaultbank | july-debits | stopped:describe | 0 | none | n/a | — / 640 | n/a | — / 123953.4 | 0 | 0 | No record types could be described: 1 resource(s), none with fields the documentation declares. |
