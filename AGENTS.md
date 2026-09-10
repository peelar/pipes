# Working on Pipes

Read `docs/design.md` before changing product behavior or architecture.

- Preserve the agreed contracts. Explicit user direction can change them.
- Deferred features are not requests to build them.
- For unspecified details, choose the simplest implementation that fits the contract.
- Surface material conflicts instead of silently changing the design.
- Keep the contract current when the user changes an agreement. Do not turn implementation guesses into product requirements.

The design document sets boundaries. It is not a task list or roadmap; the user steers the work.

## README

Do not use `README.md` as a notepad for project updates or implementation notes.
Keep it in simple, concise English: graphic and project name, one-sentence
description, core characteristics and features (which may be forward-looking),
then how to run it. Label planned features clearly.

## Changesets

PRs with user-facing changes include a changeset file (`.changeset/<name>.md`, `'pipes': patch|minor`). CI enforces this; for release-neutral PRs run `changeset add --empty`. The changesets workflow opens a `Release <version>` PR; merging it bumps the version, pushes the matching `v<version>` tag, and triggers the release workflow, which builds binaries and creates the GitHub Release automatically. Do not push version tags manually.

## Configuration compatibility

User-owned `.pipes/*.ts` files are never rewritten by Pipes (see `docs/design.md`).
Enforce it:

- Decode only through `decodeConfig` in `packages/protocol/src/config.ts`. Never decode the `Config` schema directly; a test fails new direct uses.
- Schema changes are additive-only: new fields are optional. Renames, removals, or newly required fields need explicit user direction plus a deprecation path.
- Every configuration shape change adds an immutable fixture to `packages/protocol/src/config.compat.test.ts`. Never edit an old fixture to make it pass; a red old fixture means the change is breaking.
- Stored run snapshots embed their resolved configuration and ride the same guarantee. Add a read-time upgrader only if a breaking change ever lands.

## Effect development

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely
and follow its relevant links. Search `node_modules/effect/src` for APIs the
guide does not cover. Use the installed v4 version as the source of truth.

Run `bun run check` before handing off code. It includes Oxlint with
`@nkzw/oxlint-config`, formatting, Effect-aware TypeScript checks, and Bun tests.
