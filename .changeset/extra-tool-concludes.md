---
"@freebirdai/core": minor
"@freebirdai/server": minor
---

An extra tool's result can settle the turn.

- `@freebirdai/core`: `ChatEngineOptions.extraToolConcludes(tool)`. After a step that ran extra tools the engine runs another step so the model can read the results; for a tool whose result is itself the answer, that step is a model call that usually decides to do nothing more. When the host returns true for every extra tool the step ran, and the step did nothing else, the loop ends there and the final reply is written from the results. Only under `finalReply.mode: "always"`; ignored elsewhere, and absent by default, so nothing changes for a host that does not set it.
- `@freebirdai/server`: passes `extraToolConcludes` through to the engine.
