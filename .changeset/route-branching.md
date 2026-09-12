---
'pipes': minor
---

Workflow steps can declare `routes`: a set of named outputs, each mapping to its own continuation chain. A routing step reports exactly one output with its result, and pipes runs only that output's branch — for example classifying a change as a UI change versus a deeper change and following a different flow for each.
