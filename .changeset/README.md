# Changesets

PRs with user-facing changes include a changeset file here (see
https://github.com/changesets/changesets for the format):

```md
---
'pipes': patch
---

Short description of the change.
```

Use `patch` for fixes, `minor` for features. `pipes` is private and never
publishes to npm; changesets only manages the version number and
`CHANGELOG.md`. Merging the Version Packages PR bumps the version — shipping
binaries still happens by pushing a matching tag (`git tag vX.Y.Z`), which
triggers the release workflow.
