# pipes

## 0.2.0

### Minor Changes

- 9c07a2f: GitHub policy configuration now supports `labels`, `exclude_labels`, and an ordered `routes` list for filtering issues and sending matches to different workflows. Routes can omit `workflow` to admit matching issues to the inbox for manual workflow selection, while existing single-workflow policies keep working unchanged.

### Patch Changes

- @pipes/mcp@0.2.0
  - @pipes/protocol@0.2.0
  - @pipes/server@0.2.0
  - @pipes/tui@0.2.0

## 0.1.0

### Minor Changes

- dd5beef: Add `pipes upgrade` to self-update the installed binary from GitHub Releases, restarting the background server when one is running. `pipes upgrade --check` only reports availability.

### Patch Changes

- 76a5c3a: Manage → Connections now lists the repositories already connected to pipes above a compact single-line choice list for adding new ones.
- f14f41b: Use lowercase `pipes` consistently in user-facing copy.
- 9c0da43: Keep TUI choice and repository rows on a single line so narrow panes clip instead of overlapping.
- @pipes/mcp@0.1.0
  - @pipes/protocol@0.1.0
  - @pipes/server@0.1.0
  - @pipes/tui@0.1.0
