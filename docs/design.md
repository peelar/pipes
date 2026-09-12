# Pipes design contract

This records product and architecture intent that is not yet clear from code, including unresolved decisions and features that do not exist yet. It is not a roadmap or task list.

Code becomes the source of truth once a feature's full shape is established in its implementation. Remove the corresponding design text instead of adding or maintaining a duplicate description here. Keep only intent and constraints that the code does not yet express.

- **Agreed:** preserve this unless the user changes it.
- **Deferred:** discussed, but outside the initial scope.
- **Unspecified:** left to implementation. Choose the simplest compatible approach.

The sections below are agreed unless marked otherwise. Example keyboard shortcuts and proposed command names are illustrative.

## Purpose

Pipes is a local-first, open-source personal software factory for engineering work. It turns existing coding agents and developer tools into a persistent production system.

Human attention is the scarce resource Pipes optimizes. Automate the routine parts of the software-development lifecycle, keep autonomous work moving without supervision, and make the points that require judgment obvious and information-complete.

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
The repository configuration entry point is `.pipes/config.ts`.

Each step defines an agent provider (such as `codex`), model, reasoning setting, and static prompt. Pipes resolves the provider to its ACP adapter and launch arguments; ACP is an implementation detail. A custom command is an optional advanced override. Pipes supplies standard context: the captured task request, feedback, previous results, and artifact references. Each step starts a fresh agent session. Files and explicit results carry work between steps; full transcripts are retained as evidence rather than automatically fed into every prompt.

TypeScript resolves to a serializable workflow definition at run start. Store that definition with the run. Later configuration edits affect new runs.

Initially, workflows are ordered chains of agent steps. The final step of a chain may be a routing step: it declares named outputs, each mapped to its own continuation chain. Completing a routing step requires reporting exactly one output; Pipes records it and runs only that output's chain. Routing steps may nest, and an empty continuation chain ends the workflow. Branches stay mutually exclusive: no parallel execution and no joins; a shared tail is written per branch. The agent decides how to perform its assignment; Pipes controls progression. An agent cannot silently skip or complete sibling steps.

The included starter is `plan → implement → review`, written into repository configuration and editable like any other workflow. A step named `present` has no special runtime meaning.

An optional repository setup command runs before agent steps. Setup failure prevents their execution. Command and arbitrary TypeScript workflow steps are deferred.

Unsupported agent settings fail explicitly rather than silently falling back. Validate them before execution where the provider allows it.

## Outcomes and human judgment

Before custom output schemas, steps use a fixed result: `completed`, `blocked`, or `failed`, with a summary. The agent submits it through a dedicated Pipes MCP tool. A routing step's completed result additionally carries exactly one declared output. Reports that are missing, unknown, or stray outputs are rejected as tool errors the agent may correct in the same turn; `blocked` and `failed` never carry an output. The recorded output selects the continuation chain and appears in later steps' context. Validate and persist the report, but advance only after the invocation ends successfully. A normal agent turn ending is not proof of task success.

Completion advances the chain. Blockage or failure stops progression. A user can answer a blocked step in Pipes and continue it in a fresh attempt with the answer and previous evidence.

A successful run awaits human acceptance. Acceptance closes the task as verified and finished locally. Publishing, merging, and pushing remain the user's work. MCP does not accept tasks on the user's behalf.

Pipes cannot force an arbitrary interactive harness to follow a workflow. It enforces the boundary it owns instead: claiming work grants a capability scoped to the exact task, run, step, and attempt; only the current owner can return its outcome; and Pipes advances the workflow only after that explicit outcome. Closing a harness, editing the workspace, or writing a final message does not advance work. Stale capabilities are rejected and only one writer may own a step at a time.

If a result needs changes, record feedback and create a follow-up run from the previous result. Preserve the earlier run's record. Editing a task brief does not redirect active execution: show the change and let the user finish or stop the run before starting a follow-up.

Unwanted tasks can be dismissed. Stop active work, preserve history, and remove them from the default queue. Dismissal is distinct from success.

## Server and execution

`pipes` starts the background server if needed, then attaches. Closing the TUI leaves work running. Server shutdown is explicit; foreground `pipesd` execution is also available for service managers.

Initially, clients connect to a same-host server. A user can SSH to another machine and run the client there. Keep the boundary suitable for a future LAN or cloud host without building remote connection management now.

Queue work oldest-first, with manual promotion. A configurable global limit controls concurrent agent invocations. Waiting, blocked, and human-owned steps do not occupy an agent slot.

Pausing the factory allows active invocations to finish but starts no further steps. Source intake continues. Individual task cancellation is separate. A cancelled task can be started again from scratch as a new run, preserving the cancelled run and its evidence.

Execution is permissive by default. Pushing belongs to the user. Broader sandbox policy is not part of the initial product contract; the exact push restriction mechanism remains unspecified.

## Environments and Git

An environment is an explicit abstraction. It prepares a workspace, runs and stops commands or workers, retrieves files and artifacts, and describes how to access the workspace. Clients must not require every environment to expose a host-local path.

Execution belongs to the environment so a future remote sandbox can run the same captured workflow without moving Pipes' task state or workflow decisions into the sandbox. Pipes owns scheduling, attempt ownership, result persistence, and progression; the environment owns worker launch, agent transport, result-endpoint connectivity, and process cleanup, including interactive launch. Interrupting an environment invocation must finish stopping its worker before checkpointing or granting another writer ownership. A lost connection alone cannot establish that a remote worker stopped.

This is preparation for remote execution, not remote support. The current environment remains local. Remote environment identity and recovery, repository and evidence transfer, authentication, and remote terminal access remain deferred; local workspace and session metadata must not become requirements for future environments.

The first implementation uses one Git worktree and branch per run. Fresh tasks start from a local branch or revision, optionally selected by `base`, recording the resolved commit. Do not automatically fetch a remote base. Follow-up runs start from the previous result.

After execution stops, preserve project changes in a local Git checkpoint, including relevant uncommitted and untracked changes. Record its revision. Ignored environment files stay outside the checkpoint; larger evidence belongs in artifact storage. Nothing is pushed.

Accepted results expose the branch, base revision, summary, and tool shortcuts. Pipes does not automatically merge or cherry-pick them into the user's normal checkout.

After a successful run is checkpointed, Pipes cleans up its Git worktree while preserving the local branch, recorded revision, results, and evidence. Failed, cancelled, interrupted, and human-owned environments remain available for inspection. Cleanup refuses active or human-owned environments.

## Interactive handoff

The TUI is keyboard-first. Display keyboard shortcuts in brackets. `[m] manage` opens a tabbed modal for repository connections and agent setup. Connections lists the registered repositories and presents one choice list for connecting the current repository, local directory browsing, and GitHub repositories; local and remote are not nested tabs. A configured action such as `O` opens a task in a new terminal pane or window. Terminal launch configuration is separate from harness launch configuration.

Jumping in means interactive takeover: stop the current worker and confirm it has stopped, then hold workflow progression while the human owns the step. For Codex, launch the actual bundled `codex resume` with the saved session ID in the run's worktree. Read-only conversation inspection is a separate action.

Use the user's configured interactive harness, even if another provider performed the autonomous step. It uses its own configured settings while preserving the assignment and evidence.

Launch the harness in the run's environment with Pipes MCP available and a short startup prompt identifying a handoff. Resume the original conversation when the same harness supports it. Otherwise supply the assignment and evidence in a fresh session. The handoff identifies the exact task, run, step, and purpose. The harness retrieves the brief, step instructions, results, and artifact index through MCP.

Closing the tool does not finish the step or release ownership. Explicitly return an outcome or return control for another agent attempt through TUI, CLI, or MCP. Final task acceptance remains human-owned.

## Durability and recovery

SQLite holds current state and a chronological history of meaningful transitions. Update state and transition history in the same transaction. Events are not the authoritative replay model.

Persist tasks, runs, steps, attempts, ownership and leases, resolved configuration, request snapshots, and outcomes. Store summaries and artifact metadata in SQLite; store transcripts and larger artifacts in a managed directory outside disposable environments.

Effect fibers do not survive a process crash. On restart, Pipes reconciles persisted state, preserves completed progress, and continues runnable work. An invocation that may have started but has no trustworthy completion is interrupted and needs intervention; do not automatically invoke it again.

Retry only infrastructure operations known to be safe initially. A timeout, failed test, or agent-reported failure is not automatically permission to repeat agent actions. Keep failures typed and give their handling explicit meaning. Detailed policies remain open.

Lease expiration signals uncertainty, not proof that a worker stopped. Confirm the previous writer has stopped before another worker or human takes ownership.

## Sources and onboarding

The first TUI launch shows an animated Pipes logo before repository onboarding. Later launches skip it.

A one-time, resumable wizard connects a repository, checks the automatic Codex connection, then confirms creation of example plan → implement → review pipes. The final [Enter] action creates `.pipes/config.ts` using Codex’s advertised default model and reasoning settings and completes onboarding after success. A brief success message appears in the main view after completion. There are no model selectors or extra ready screen. Existing configuration can be validated instead and is never overwritten. Finishing later resumes setup on the next launch. Agent settings remain editable per workflow step in configuration and setup remains available through the Agent tab in [m] manage. Pipes bundles its ACP adapter. It expects a `codex` CLI on PATH and authenticates through the user's Codex account; installing Codex separately is required for now. Bundling the Codex engine inside Pipes is deferred.

The Codex connection step only checks availability and authentication, showing “Connected to Codex” on success. The separate configuration step shows a compact addition diff of the example configuration, with abbreviated agent settings and prompts, without repeating the connection status. Agent settings are defined per workflow step rather than for the connection.

Codex connection setup uses the maintained `@agentclientprotocol/codex-acp` adapter. Discover model choices through ACP, apply the selected model, then refresh its reasoning choices and verify the selected settings. Connection checks do not send an agent assignment. Selected settings can create the starter repository configuration; preserve existing TypeScript configuration and show the settings to incorporate into it.

Pipes provides a Codex skill for interactive use. The skill describes the behavioral rules for operating Pipes, but does not duplicate the CLI command surface. It directs Codex to discover the installed version's commands through `pipes --help` and command-specific help. The Agent view detects whether the MCP server and skill are installed and, when either is missing, shows an action to install both without overwriting existing configuration.

Repositories are registered explicitly through TUI or CLI. Check configuration and offer the starter workflow when missing. GitHub supplies work for registered repositories.

GitHub authentication uses the public [Pipes GitHub](https://github.com/apps/pipes-github) App through OAuth device flow. Pipes opens GitHub's installation UI so the user chooses each account and repository grant before authorization, and can manage those grants later. The installed client contains the app's public client ID but no client secret or private key. Pipes does not accept general user tokens, impersonate GitHub CLI, or depend on its credentials.

For local registration, the TUI detects the repository containing its launch directory. If it is not registered, outside the first-time wizard, ask whether to connect it to Pipes, with explicit Yes/No choices in a centered modal over the main UI. The background remains visible but keyboard interaction stays in the modal. Declining continues without registration for that session; registered repositories are not prompted again. A keyboard directory picker supports browsing and typed paths with completion and home-directory expansion. Discovery does not register repositories automatically or scan the disk in the background.

GitHub is a continuous source, alongside manual submission through Pipes interfaces. Each source owns its delivery mechanism, eligibility rules, and mapping to a registered repository and workflow. Sources submit through the same durable task admission boundary, whether they poll or receive webhooks; task execution does not depend on delivery. GitHub polls every minute while the server runs and once on startup. Optional webhooks can accelerate delivery when the user provides reachable connectivity, such as an endpoint or tunnel. Pipes requires no Pipes-operated relay.

When execution is implemented, code configuration will also determine whether admitted tasks start automatically. Manual callers can select a workflow directly.

Future run and task lifecycle operations must preserve source deduplication: repeated observations must not create another run or reopen a closed task. Source synchronization and progress updates back to GitHub are deferred.

## Interfaces

OpenCode is the visual inspiration for the TUI: restrained color, terminal-native iconography, and compact keyboard-first interactions. The selected-task view prioritizes tracking work over reading its description. Keep the pipes breakdown in the header's second column and avoid repeating information within the view.

The TUI uses roughly the left third for the task queue and the right two-thirds for the selected task. Show steps, status, available live agent messages and tool activity, summaries, and evidence. The live view is read-only; direct agent conversation stays in the user's harness, apart from replies to blocked steps.

Results lead with changes, checks performed, unresolved concerns, and shortcuts to inspect the work. Attention stays inside Pipes initially; external and desktop notifications are deferred.

CLI/JSON is the automation interface. MCP is the primary work interface for agents; the TUI is the human control plane. TUI and CLI use the same server operations through Effect RPC; MCP adapts to the application capabilities.

MCP answers attention-first questions with structured context. “What requires my attention?” returns only work Pipes cannot progress autonomously, why it stopped, the requested outcome and source, the current workflow position, prior step results, evidence references, and the valid next actions. “What was recently done?” returns recent outcomes and checks rather than raw activity. Detailed transcripts and artifacts are fetched on demand.

An agent may submit an ad-hoc task and select a configured workflow through MCP. Submission and execution are distinct durable operations even when one tool performs both for convenience: a successfully admitted task remains visible if configuration validation or run startup fails. Runs execute detached from the MCP client and client disconnection does not cancel them.

Interactive work entered through MCP must claim the current step before writing. The claim supplies the same assignment and evidence as an autonomous attempt. Returning `completed`, `blocked`, or `failed` releases ownership and lets Pipes apply the ordinary workflow transition; returning control without an outcome creates a fresh agent attempt. Acceptance, dismissal, publishing, merging, and pushing remain explicit human actions and are never inferred from conversation.

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

Support macOS and Linux; Windows users can use WSL. Ship a single executable containing the Pipes runtime and its ACP adapter. The Codex engine is expected on PATH for now; bundling it is deferred. Source development may require build tools; the installed product requires only the binary plus a `codex` CLI, not Bun, Node, or package managers.

## Deferred

- Team ownership and collaboration.
- Cloud environments and built-in remote client connectivity.
- Additional source integrations and bidirectional source synchronization.
- Parallel graph branches and joins.
- Automatic agent recovery loops and configurable agent retry policies.
- Custom step-output schemas, deterministic workflow steps, and arbitrary code steps.
- Child tasks and automatic task dependency scheduling.
- Session transfer between different providers and built-in editor integrations.
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
