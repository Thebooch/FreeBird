# Benchmark: agent, dev split

- Date: 2026-09-28T21:22:46.378Z
- Choices: the integrator's own
- Model: gpt-5.6-terra

| | Count |
|---|---|
| Scenarios | 4 |
| Task success | 0 |
| Setup done | 3 |
| With a technical intervention | 0 |
| Retrieval ok | 3 |
| Complete | 1 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 2 |
| Metric correct | 0 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ledgerly | invoice-count | done | 0 | ok | incomplete-silent | 1 / 1234 | wrong | 1 / 1234 | 30 | 2 |  |
| ledgerly | open-total | stopped:build | 0 | none | n/a | — / 1234 | n/a | — / 879419.12 | 0 | 2 | The brief did not compile: A sum needs a field to add up; only a count can leave one out. |
| taskpad | done-count | done | 0 | ok | complete | 57 / 57 | wrong | 57 / 25 | 2 | 2 |  |
| searchy | shipped-count | done | 0 | ok | incomplete-silent | 1 / 140 | wrong | 1 / 67 | 16 | 2 |  |
