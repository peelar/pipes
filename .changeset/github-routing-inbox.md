---
'pipes': minor
---

GitHub policy configuration now supports `labels`, `exclude_labels`, and an ordered `routes` list for filtering issues and sending matches to different workflows. Routes can omit `workflow` to admit matching issues to the inbox for manual workflow selection, while existing single-workflow policies keep working unchanged.
