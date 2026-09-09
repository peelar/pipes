# Pipes

```text
╭───┬───╮  ╭┬─────┬╮  ╭───┬───╮  ╭───┬───╮  ╭───┬───╮
│ ╭─┴─╮ │  ╰┴─╮ ╭─┴╯  │ ╭─┴─╮ │  │ ╭─┴───╯  │ ╭─┴───╯
│ │   │ │     │ │     │ │   │ │  │ ╰─┬──╮   │ ╰─┬───╮
│ ╰─┬─╯ │     ├─┤     │ ╰─┬─╯ │  │ ╭─┴──╯   ╰───┴─╮ │
│ ╭─┴───╯     │ │     │ ╭─┴───╯  ├─┤              ├─┤
├─┤        ╭┬─╯ ╰─┬╮  ├─┤        │ ╰─┬───╮  ╭───┬─╯ │
╰─╯        ╰┴─────┴╯  ╰─╯        ╰───┴───╯  ╰───┴───╯
```

A terminal-based personal software factory built to protect your attention.

Pipes lets you codify how you work depending on where you work. For each repository and source of intake (GitHub, Linear, Sentry, etc.) that you maintain, define a TypeScript workflow (pipe):

```ts
import { pipe } from "pipes";

export default pipe({
  workflows: {
    'plan-implement-review': {
      steps: [
        {
          name: 'plan',
          agent: {
            model: 'gpt-5.6-sol',
            provider: 'codex',
            reasoning: 'high',
          },
          prompt:
            'Read the task and repository. Write an actionable implementation plan, including checks and open questions.',
        },
        ...
      ],
    },
  },
});
```

## Features

- A keyboard-first terminal UI with live agent messages, tool activity, and step progress.
- Work that keeps running in the background, with tasks and history saved locally in SQLite.
- TypeScript workflows with model, reasoning, and prompt settings for each step. Start with plan → implement → review and make it yours.
- Separate Git worktrees for each run, with results saved to local branches.
- Interactive takeover: jump into a task's Codex session when you want to take the wheel.
- Work intake from connected tools: GitHub today, with more sources such as Linear and Sentry planned.
- MCP access for delegating work from your coding agent.
- Bundled agent adapter with guided setup — bring your own Codex CLI on PATH.
- Planned: human review and follow-up runs before accepting finished work.

## Run

Install the single binary (macOS and Linux; Windows users can use WSL).
Requires the Codex CLI and Git.

```sh
curl -fsSL https://raw.githubusercontent.com/peelar/pipes/main/scripts/install.sh | sh
pipes
```

Setup walks you through connecting a repository and creating your first workflow.
If Codex needs you to sign in, run `pipes agent login`.

From a source checkout instead (requires Bun 1.4.2+):

```sh
bun install
bun run pipes
```

Press `[n]` to add your first task, then `[s]` to start a workflow. Watch it progress, or press
`[j]` to jump into its Codex session. When you're done watching, `[q]` closes the UI
and leaves Pipes working. Run `bun run pipes` to return, or
`bun run pipes shutdown` to stop the server.
