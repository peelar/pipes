---
'pipes': minor
---

GitHub intake now supports label filters and per-label workflow routing. A policy can declare `labels` / `exclude_labels` and an ordered `routes` list that maps matching issues to different workflows; issues admitted without a workflow wait in the queue as an inbox item to start manually. Existing single-workflow policies keep working unchanged.
