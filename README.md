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

A local tool for managing coding tasks and agent workflows across your Git repositories.

## Features

- Keyboard-first terminal UI and command-line access.
- Tasks and history saved locally in SQLite.
- A background server that stays running when you close the UI.
- Workflows defined in TypeScript, with agent, model, and reasoning settings for each step.
- Guided Codex connection setup.
- Planned: agent execution in Git worktrees, GitHub issue intake, and MCP access.
- Planned: human review and follow-up runs before accepting finished work.

## Run

Requires Bun 1.4.2+ and Git for source development. From this checkout:

```sh
bun install
bun run dev
```

Codex and its adapter are included. If needed, sign in:

```sh
bun run pipes agent login
```

Follow the setup prompts, connect a repository, and press `[n]` to add a task.
Press `[q]` to close the UI. Stop the background server with `bun run pipes shutdown`.

Run development checks with `bun run check`.
