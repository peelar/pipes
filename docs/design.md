# Pipes design contract

This records the agreed product and architecture. It is not a roadmap or task list.

- **Agreed:** preserve this unless the user changes it.
- **Deferred:** discussed, but outside the initial scope.
- **Unspecified:** left to implementation. Choose the simplest compatible approach.

The sections below are agreed unless marked otherwise. Example keyboard shortcuts and proposed command names are illustrative.

## Purpose

Pipes is a local-first, open-source personal software factory for engineering work. It turns existing coding agents and developer tools into a persistent production system.

It is single-player first. One person's server manages work across explicitly registered repositories. Work is the central abstraction; agents are replaceable workers.

Pipes has a terminal control surface, not an IDE or GUI. It hands work to coding harnesses, editors, terminals, browsers, and Git tools.

```text
GitHub / manual submission
           ↓
       durable server
           ↓
     task → run → steps
                    ↓
             agent / human

TUI / CLI / MCP ↔ server ↔ environments
                    ↓
             SQLite + artifacts
```

## Domain

| Concept     | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| Task        | A requested outcome owned by Pipes, independent of its source.              |
| Run         | One execution of a captured workflow and task request.                      |
| Pipe / step | One agent assignment within a workflow. A pipe means one step.              |
| Attempt     | One worker invocation for a step. Repeating a step creates another attempt. |
| Environment | The workspace and execution capabilities supplied to a run.                 |
| Artifact    | Saved evidence or output that later steps and humans can retrieve.          |

A task has a title, Markdown brief, one registered repository, and optional source references. Source issues and resulting branches are not its identity.

A task can have successive runs, with only one active run at a time. Different tasks can run concurrently. Runs retain their original request and resolved workflow configuration.

Agents can break assignments into internal plans. Pipes initially has no child-task model or dependency scheduler. A dependency on other work is recorded as a blockage and continued explicitly.

## Workflows and configuration

Workflows, policies, and agent settings live in `.pipes/*.ts`, versioned with Git. Repository code contains the exact agent settings; there is no personal override hierarchy for autonomous execution.

Code-defined workflows are reusable entry points, not only source-triggered automation. A user working in Codex can submit a new task and select one of the repository's configured workflows, such as an `RPI` (`research → plan → implement`) workflow, through Pipes MCP.

Use ordinary TypeScript exports and imports for reuse. Steps are declared within workflows; there is no separate managed pipe or profile registry.

Configuration is declarative: plain objects describe workflows and their ordered steps. `plan → implement → review` is an editable example, not a built-in execution mode.
The repository configuration entry point is `.pipes/pipes.ts`.
The `base` setting is optional; resolution when omitted remains unspecified until execution is implemented.

Each step defines an agent provider (such as `codex`), model, reasoning setting, and static prompt. Pipes resolves the provider to its ACP adapter and launch arguments; ACP is an implementation detail. A custom command is an optional advanced override. Pipes supplies standard context: the captured task request, feedback, previous results, and artifact references. Each step starts a fresh agent session. Files and explicit results carry work between steps; full transcripts are retained as evidence rather than automatically fed into every prompt.

TypeScript resolves to a serializable workflow definition at run start. Store that definition with the run. Later configuration edits affect new runs.

Initially, workflows are ordered chains of agent steps. The agent decides how to perform its assignment; Pipes controls progression. An agent cannot silently skip or complete sibling steps.

The included starter is `plan → implement → review`, written into repository configuration and editable like any other workflow. A step named `present` has no special runtime meaning.

An optional repository setup command runs before agent steps. Setup failure prevents their execution. Command and arbitrary TypeScript workflow steps are deferred.

Unsupported agent settings fail explicitly rather than silently falling back. Validate them before execution where the provider allows it.

## Outcomes and human judgment

Before custom output schemas, steps use a fixed result: `completed`, `blocked`, or `failed`, with a summary. The agent submits it through a dedicated Pipes MCP tool. Validate and persist the report, but advance only after the invocation ends successfully. A normal agent turn ending is not proof of task success.

Completion advances the chain. Blockage or failure stops progression. A user can answer a blocked step in Pipes and continue it in a fresh attempt with the answer and previous evidence.

A successful run awaits human acceptance. Acceptance closes the task as verified and finished locally. Publishing, merging, and pushing remain the user's work. MCP does not accept tasks on the user's behalf.

If a result needs changes, record feedback and create a follow-up run from the previous result. Preserve the earlier run's record. Editing a task brief does not redirect active execution: show the change and let the user finish or stop the run before starting a follow-up.

Unwanted tasks can be dismissed. Stop active work, preserve history, and remove them from the default queue. Dismissal is distinct from success.

## Server and execution

`pipes` starts the background server if needed, then attaches. Closing the TUI leaves work running. Server shutdown is explicit; foreground `pipesd` execution is also available for service managers.

Initially, clients connect to a same-host server. A user can SSH to another machine and run the client there. Keep the boundary suitable for a future LAN or cloud host without building remote connection management now.

Queue work oldest-first, with manual promotion. A configurable global limit controls concurrent agent invocations. Waiting, blocked, and human-owned steps do not occupy an agent slot.

Pausing the factory allows active invocations to finish but starts no further steps. Source intake continues. Individual task cancellation is separate.

Execution is permissive by default. Pushing belongs to the user. Broader sandbox policy is not part of the initial product contract; the exact push restriction mechanism remains unspecified.

## Environments and Git

An environment is an explicit abstraction. It prepares a workspace, runs and stops commands or workers, retrieves files and artifacts, and describes how to access the workspace. Clients must not require every environment to expose a host-local path.

The first implementation uses one Git worktree and branch per run. Fresh tasks start from a local branch or revision, optionally selected by `base`, recording the resolved commit. Do not automatically fetch a remote base. Follow-up runs start from the previous result.

After execution stops, preserve project changes in a local Git checkpoint, including relevant uncommitted and untracked changes. Record its revision. Ignored environment files stay outside the checkpoint; larger evidence belongs in artifact storage. Nothing is pushed.

Accepted results expose the branch, base revision, summary, and tool shortcuts. Pipes does not automatically merge or cherry-pick them into the user's normal checkout.

Environment cleanup is explicit. Refuse cleanup of active or human-owned environments and preserve recorded results and evidence when cleaning up.

## Interactive handoff

The TUI is keyboard-first. A configured action such as `O` opens a task in a new terminal pane or window. Terminal launch configuration is separate from harness launch configuration.

Opening defaults to inspection. Claiming is a separate action: stop the current worker and confirm it has stopped before granting human ownership. Inspection must not rely only on prompt wording to prevent changes in supported harnesses.

Use the user's configured interactive harness, even if another provider performed the autonomous step. It uses its own configured settings while preserving the assignment and evidence.

Launch the harness in the run's environment with Pipes MCP available and a short startup prompt identifying a handoff. The handoff identifies the exact task, run, step, and purpose. The harness retrieves the brief, step instructions, results, and artifact index through MCP. Do not depend on restoring the original agent conversation.

Closing the tool does not finish the step or release ownership. Explicitly return an outcome or return control for another agent attempt through TUI, CLI, or MCP. Final task acceptance remains human-owned.

## Durability and recovery

SQLite holds current state and a chronological history of meaningful transitions. Update state and transition history in the same transaction. Events are not the authoritative replay model.

Persist tasks, runs, steps, attempts, ownership and leases, resolved configuration, request snapshots, and outcomes. Store summaries and artifact metadata in SQLite; store transcripts and larger artifacts in a managed directory outside disposable environments.

Effect fibers do not survive a process crash. On restart, Pipes reconciles persisted state, preserves completed progress, and continues runnable work. An invocation that may have started but has no trustworthy completion is interrupted and needs intervention; do not automatically invoke it again.

Retry only infrastructure operations known to be safe initially. A timeout, failed test, or agent-reported failure is not automatically permission to repeat agent actions. Keep failures typed and give their handling explicit meaning. Detailed policies remain open.

Lease expiration signals uncertainty, not proof that a worker stopped. Confirm the previous writer has stopped before another worker or human takes ownership.

## Sources and onboarding

The first TUI launch shows an animated Pipes logo before repository onboarding. Later launches skip it.

Onboarding starts with configuring agents and connecting GitHub. Discover supported installed providers, let the user select advertised settings, and verify the connection. Pipes provides instructions for missing installation or authentication; it does not manage those tools itself.

Repositories are registered explicitly through TUI or CLI. Check configuration and offer the starter workflow when missing. GitHub supplies work for registered repositories.

For local registration, the TUI detects the repository containing its launch directory. If it is not registered, immediately ask whether to initialize it in Pipes, with explicit Yes/No choices in a centered modal over the main UI. The background remains visible but keyboard interaction stays in the modal. Declining continues without registration for that session; registered repositories are not prompted again. A keyboard directory picker supports browsing and typed paths with completion and home-directory expansion. Discovery does not register repositories automatically or scan the disk in the background.

GitHub is a continuous source, alongside manual submission through Pipes interfaces. Source mechanisms are abstract: GitHub uses webhooks; other sources may poll. Users provide reachable webhook connectivity, such as an endpoint or tunnel. Pipes requires no Pipes-operated relay.

Code configuration selects eligible work and routes it to a workflow, including whether it starts automatically. Manual callers can select a workflow directly. The only initial source filter is `assigned_to_me: true/false`; the exact meaning of `false` remains open.

Admit existing matching issues when watching starts. Maintain one task per source issue. Repeated observations do not create another task or run, rewrite the captured request, or reopen a closed task. Initial source content is a snapshot plus a link. Source synchronization and progress updates back to GitHub are deferred.

## Interfaces

The TUI uses roughly the left third for the task queue and the right two-thirds for the selected task. Show steps, status, available live agent messages and tool activity, summaries, and evidence. The live view is read-only; direct agent conversation stays in the user's harness, apart from replies to blocked steps.

Results lead with changes, checks performed, unresolved concerns, and shortcuts to inspect the work. Attention stays inside Pipes initially; external and desktop notifications are deferred.

CLI/JSON is the automation interface. MCP lets agents inspect work and evidence, submit tasks, start runs, claim and return steps, and submit feedback. TUI and CLI use the same server operations through Effect RPC; MCP adapts to the application capabilities.

Client disconnection ends observation, not durable work. Cancellation is an explicit server operation. GitHub webhook ingress is separate from privileged control operations.

## Technical foundation

- **TypeScript and Bun:** implementation and runtime.
- **React and OpenTUI:** terminal interface.
- **Effect v4:** execution foundation, not the durable workflow engine.
- **SQLite:** durable state, with managed files for larger artifacts.
- **Effect RPC:** client/server operations and streams.
- **Oxlint with `@nkzw/oxlint-config`:** linting.
- **ACP:** replaceable agent workers.
- **MCP:** agent access to Pipes.

Model step execution as `Effect<Success, Error, Requirements>`. Use typed failures, fibers and scopes for concurrency and cleanup, services and layers for dependencies, schedules for safe retries and timing, and structured logs, metrics, and traces for observability.

Use Effect Schema at boundaries: webhooks, MCP, runner responses, resolved workflow data, and persisted state. This boundary validation is distinct from deferred custom step-output schemas.

Capabilities such as runners, sources, environments, persistence, and artifact storage are Effect services. Add concrete services as their features enter scope, not as placeholders for future integrations.

The split is: **Effect owns execution; SQLite provides durability; Pipes owns workflow semantics and state transitions.** Do not use Effect Workflow as the durable engine.

The provider setting is an enum with only `codex` supported initially. Allow an optional custom ACP command override for that provider. Add other provider values explicitly as support is implemented.

Support macOS and Linux; Windows users can use WSL. Ship an executable or release bundle containing the Pipes runtime. Agent providers and development tools remain separate prerequisites.

## Deferred

- Team ownership and collaboration.
- Cloud environments and built-in remote client connectivity.
- Additional source integrations and bidirectional source synchronization.
- Branching, parallel graph branches, joins, and agent-driven routing.
- Automatic agent recovery loops and configurable agent retry policies.
- Custom step-output schemas, deterministic workflow steps, and arbitrary code steps.
- Child tasks and automatic task dependency scheduling.
- Exact agent-session transfer and built-in editor integrations.
- Automatic environment retention, login-service installation, and external notifications.

## Unspecified

Implementation may choose these details without inventing new product scope:

- Exact tables, fields, status names, API operations, and file layout.
- Configuration loading, validation presentation, and starter-file mechanics.
- Authentication, secret storage, webhook setup, and catch-up after downtime.
- Timeout values, error taxonomy, retry parameters, and reconciliation mechanics.
- MCP handoff format, harness flags, terminal launchers, and key bindings.
- Git checkpoint mechanics, supported edge cases, packaging, and dependency versions.

Preserve the agreed behavior when choosing these details. Surface choices that would change a contract instead of silently redefining it.
