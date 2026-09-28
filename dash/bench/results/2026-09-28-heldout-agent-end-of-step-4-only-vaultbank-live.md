# Benchmark: agent, heldout split — end-of-step-4

- Date: 2026-09-28T15:31:12.399Z
- Choices: scripted (measures mechanics, not judgment — see PROTOCOL.md)
- Model: gpt-5.6-terra

| | Count |
|---|---|
| Scenarios | 1 |
| Task success | 0 |
| Setup done | 0 |
| With a technical intervention | 0 |
| Retrieval ok | 0 |
| Complete | 0 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 0 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| vaultbank | july-debits | stopped:integrate | 0 | none | n/a | — / 640 | n/a | — / 123953.4 | 0 | 2 | The documentation does not define the possible export status values or the polling interval. This connector treats status "ready" as complete and polls once per second, bounded by the run page limit. |
