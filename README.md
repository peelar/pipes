# Pipes

```text
╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮  ╭───────╮
│ ╭───╮ │  ╰──╮ ╭──╯  │ ╭───╮ │  │ ╭─────╯  │ ╭─────╯
│ │   │ │     │ │     │ │   │ │  │ ╰────╮   │ ╰─────╮
│ ╰───╯ │     │ │     │ ╰───╯ │  │ ╭────╯   ╰─────╮ │
│ ╭─────╯     │ │     │ ╭─────╯  │ │              │ │
│ │        ╭──╯ ╰──╮  │ │        │ ╰─────╮  ╭─────╯ │
╰─╯        ╰───────╯  ╰─╯        ╰───────╯  ╰───────╯
```

A persistent local task queue with a terminal UI. This first slice registers Git
repositories, captures tasks and their briefs, and keeps a chronological submission
history in SQLite. Agent execution and GitHub intake are not connected yet.

## Run

Requires **Bun 1.4.2+** and Git. Development checks also need **Node 22.18+**.

```sh
bun install
bun run dev
```

The first TUI launch reveals the Pipes logo, then opens the queue. Press any key
to skip the animation. Later launches skip it automatically; the marker lives in
the Pipes data directory.

On launch inside an unregistered Git repository, Pipes asks whether
to initialize it: Enter or `y` confirms; `n` or Esc skips for this session.
Initialization currently registers the repository without changing its files.
In the TUI, `r` opens a
directory picker: arrows move, Enter opens a folder or confirms registration,
Left goes to the parent, and `p` lets you type a path (`~` supported, Tab completes).
Relative paths resolve from the displayed directory. Esc cancels.
`Tab` chooses the repository for new tasks,
`n` opens the task form, and `Ctrl+S` submits the brief. Use arrows to select tasks
or switch to the detail pane and scroll. `q` detaches; the server keeps running.

From another terminal:

```sh
bun run pipes register .
# Use the repository ID printed above:
bun run pipes submit "Investigate slow tests" --repo REPOSITORY_ID --brief "Find the slowest tests and explain why."
bun run pipes list --json
bun run pipes shutdown
```

`bun run pipesd` runs the server in the foreground. The server listens only on
loopback and authenticates clients with a private local token. Data and logs live
in `~/.local/share/pipes/`. Override `PIPES_DATA_DIR` and `PIPES_PORT` together to
run an isolated instance. The default port is 43187. Queue updates arrive over an
Effect RPC stream refreshed once per second. Reopen the client after server loss.

## Repository configuration

[.pipes/pipes.ts](.pipes/pipes.ts) is the editable `plan → implement → review`
example. It exports a plain object checked with `satisfies Config`; no builder or
workflow DSL is needed. Ordinary TypeScript constants and imports share settings.

- `base`: optional local Git branch or revision for fresh runs. Default resolution
  will be defined when execution is connected.
- `setup`: optional command, expressed as `[executable, ...arguments]`.
- `workflows`: named workflows, each containing an ordered `steps` array.
- Each step has a unique `name`, a static `prompt`, and an `agent` containing its
  `provider` (currently only `codex`), exact `model`, and `reasoning` IDs.

Pipes will resolve the provider to its adapter and launch arguments. An optional
agent `command` override accepts `[executable, ...arguments]` for custom launches.
Replace the example's model and reasoning placeholders with settings advertised
by your provider. Step prompts describe assignments; Pipes will supply task context and
previous results separately when execution is connected.

Validate and print the resolved configuration:

```sh
bun run pipes config        # .pipes/pipes.ts in the current directory
bun run pipes config /path/to/repository
```

This runs trusted repository TypeScript, including its imports, and checks the
default export with Effect Schema. Unknown fields, empty workflows, duplicate
step names, and malformed settings fail explicitly. Each command loads a fresh
configuration. Validation does not launch an agent, run setup, or verify that a
provider supports the chosen settings; ACP integration comes next. Registration
still only records the repository and does not generate configuration files.

## Development tooling

To start user testing from scratch, close the TUI and run `bun run db:reset`, then
`bun run dev`. This stops the server and permanently deletes the SQLite database
(all registered repositories, tasks, and history), without a backup. Git repositories
are untouched. It honors `PIPES_DATA_DIR` and `PIPES_PORT`; logs and the auth token remain.

```sh
bun run check       # Oxfmt + Oxlint + Effect-aware TypeScript + Bun integration test
bun run lint
bun run fmt
bun run typecheck
bun test
```

[Vite+ supports Bun](https://viteplus.dev/guide/install) as a package manager and
[runs package scripts](https://viteplus.dev/guide/run). We use its local package for
Oxfmt, Oxlint, and task execution. With `vp` installed, use `vp run dev`,
`vp run test`, and `vp run check`. The built-in `vp dev` and `vp test` invoke Vite
and Vitest; our OpenTUI and SQLite code needs Bun. Bun owns runtime execution and
the lockfile. No global Vite+ runtime shims are required.

Linting extends [`@nkzw/oxlint-config`](https://github.com/nkzw-tech/oxlint-config).
The additional [`complexity`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/complexity.html)
rule is an error with the default maximum of 20. React DOM property validation is
disabled only for the terminal TSX components, which use OpenTUI elements.

[`@effect/tsgo`](https://github.com/Effect-TS/tsgo) patches the pinned TypeScript 7
compiler during `bun install`. Both `tsc` and supported editors then gain Effect
diagnostics, quick fixes, and refactors. Workspace editor settings select that
compiler. Run `bun run typecheck` to check missing services, floating effects, and
other Effect mistakes. Vite+'s built-in typechecker is not the Effect-patched
compiler, so `bun run check` explicitly runs `tsc` after `vp check`.

The official [Effect skill](https://github.com/Effect-TS/skills) is installed in
`.agents/skills/effect-ts`. `AGENTS.md` directs agents to the documentation and
source bundled with our exact Effect v4 version, rather than older v3 examples.

The integration test starts an isolated daemon, submits through the CLI, exercises
the actual terminal renderer and task form, checks input rejection and auth, then
restarts the daemon and verifies persistence. It leaves its temporary database
and log under the OS temporary directory for diagnosis.
