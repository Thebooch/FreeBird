# Benchmark: agent, real split — trackc-1-final

- Date: 2026-09-28T23:46:41.822Z
- Choices: the integrator's own
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
| dummyjson-products | smartphones | done | 0 | ok | incomplete-flagged | 30 / 194 | wrong | 3 / 16 | 28 | 3 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| dummyjson-products | stock | done | 0 | ok | incomplete-flagged | 30 / 194 | wrong | 1458 / 9779 | 28 | 3 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| dummyjson-products | over-100 | done | 0 | ok | incomplete-flagged | 30 / 194 | wrong | 0 / 61 | 28 | 3 | Only the first page was read, because how this API splits its results into pages has not been confirmed yet. What is shown may exclude additional records. |
| dummyjson-carts | discounted-value | done | 0 | ok | complete | 208 / 208 | correct | 3456709.58 / 3456709.58 | 14 | 3 |  |
| jsonplaceholder-todos | done | done | 0 | ok | complete | 200 / 200 | correct | 90 / 90 | 15 | 3 |  |
