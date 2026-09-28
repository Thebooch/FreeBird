# Benchmark: agent, dev split

- Date: 2026-09-28T15:17:29.432Z
- Choices: scripted (measures mechanics, not judgment — see PROTOCOL.md)
- Model: scripted per provider

| | Count |
|---|---|
| Scenarios | 2 |
| Task success | 2 |
| Setup done | 2 |
| With a technical intervention | 0 |
| Retrieval ok | 2 |
| Complete | 2 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 2 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sessionly | open-tickets | done | 0 | ok | complete | 230 / 230 | correct | 59 / 59 | 8 | 1 |  |
| stampede | paid-total | done | 0 | ok | complete | 180 / 180 | correct | 17318.28 / 17318.28 | 15 | 2 |  |
