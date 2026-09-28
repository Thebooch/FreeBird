# Benchmark: agent, real split — real-1

- Date: 2026-09-28T22:05:28.730Z
- Choices: scripted (measures mechanics, not judgment — see PROTOCOL.md)
- Model: gpt-5.6-terra

| | Count |
|---|---|
| Scenarios | 5 |
| Task success | 2 |
| Setup done | 5 |
| With a technical intervention | 0 |
| Retrieval ok | 5 |
| Complete | 2 |
| Incomplete, and said so | 3 |
| Incomplete, silently | 0 |
| Metric correct | 2 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dummyjson-products | smartphones | done | 0 | ok | incomplete-flagged | 30 / 194 | wrong | 3 / 16 | 8 | 1 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| dummyjson-products | stock | done | 0 | ok | incomplete-flagged | 30 / 194 | wrong | 1458 / 9779 | 8 | 1 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| dummyjson-products | over-100 | done | 0 | ok | incomplete-flagged | 30 / 194 | wrong | 6 / 61 | 8 | 1 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| dummyjson-carts | discounted-value | done | 0 | ok | complete | 208 / 208 | correct | 3456709.58 / 3456709.58 | 10 | 1 |  |
| jsonplaceholder-todos | done | done | 0 | ok | complete | 200 / 200 | correct | 90 / 90 | 3 | 1 |  |
