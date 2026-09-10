# Changesets

PRs with user-facing changes include a changeset file here (see
https://github.com/changesets/changesets for the format):

```md
---
'pipes': patch
---

Short description of the change.
```

Use `patch` for fixes, `minor` for features. `pipes` (in `packages/pipes`)
is the release package: it is private and never publishes to npm.
All workspace packages move in lockstep via the `fixed` group in
`config.json`, so there is a single version number everywhere.
`packages/pipes/CHANGELOG.md` carries the release notes.
Merging the Version Packages PR bumps the version — shipping
binaries still happens by pushing a matching tag (`git tag vX.Y.Z`), which
triggers the release workflow.
