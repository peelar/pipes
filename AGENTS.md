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

PRs with user-facing changes include a changeset file (`.changeset/<name>.md`, `'pipes': patch|minor`). Merging the Version Packages PR bumps the version; ship binaries by pushing a matching tag, which triggers the release workflow.

## Effect development

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely
and follow its relevant links. Search `node_modules/effect/src` for APIs the
guide does not cover. Use the installed v4 version as the source of truth.

Run `bun run check` before handing off code. It includes Oxlint with
`@nkzw/oxlint-config`, formatting, Effect-aware TypeScript checks, and Bun tests.
