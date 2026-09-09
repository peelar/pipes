# Working on Pipes

Read `docs/design.md` before changing product behavior or architecture.

- Preserve the agreed contracts. Explicit user direction can change them.
- Deferred features are not requests to build them.
- For unspecified details, choose the simplest implementation that fits the contract.
- Surface material conflicts instead of silently changing the design.
- Keep the contract current when the user changes an agreement. Do not turn implementation guesses into product requirements.

The design document sets boundaries. It is not a task list or roadmap; the user steers the work.

## Effect development

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely
and follow its relevant links. Search `node_modules/effect/src` for APIs the
guide does not cover. Use the installed v4 version as the source of truth.

Run `bun run check` before handing off code. It includes Oxlint with
`@nkzw/oxlint-config`, formatting, Effect-aware TypeScript checks, and Bun tests.
