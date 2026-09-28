# Benchmark: agent, dev split — trackc-1

- Date: 2026-09-28T23:33:06.236Z
- Choices: the integrator's own
- Model: gpt-5.6-terra

| | Count |
|---|---|
| Scenarios | 2 |
| Task success | 1 |
| Setup done | 1 |
| With a technical intervention | 0 |
| Retrieval ok | 1 |
| Complete | 1 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 1 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sessionly | open-tickets | done | 0 | ok | complete | 230 / 230 | correct | 59 / 59 | 30 | 3 |  |
| vaultbank | july-debits | stopped:describe | 0 | none | n/a | — / 640 | n/a | — / 123953.4 | 5 | 2 | No record types could be described: 1 resource(s), none with fields the documentation declares. |
