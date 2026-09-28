# Benchmark: agent, heldout split — after step-2 fixes

- Date: 2026-09-28T01:07:21.701Z
- Choices: scripted (measures mechanics, not judgment — see PROTOCOL.md)
- Model: scripted per provider

| | Count |
|---|---|
| Scenarios | 1 |
| Task success | 0 |
| Setup done | 0 |
| With a technical intervention | 1 |
| Retrieval ok | 0 |
| Complete | 0 |
| Incomplete, and said so | 0 |
| Incomplete, silently | 0 |
| Metric correct | 0 |

| Provider | Objective | Setup | Tech. int. | Retrieval | Completeness | Read / held | Metric | Value / expected | Requests | Model calls | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| vaultbank | july-debits | stopped:integrate | 1 | none | n/a | — / 640 | n/a | — / 123953.4 | 0 | 0 | The "signed" sign-in scheme uses signed requests (AWS Signature, HMAC), which is not supported yet. Requests cannot be signed yet. |
