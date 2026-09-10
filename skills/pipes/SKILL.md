---
name: pipes
description: Operate pipes when the user wants to delegate, inspect, or control durable engineering work from a coding agent.
---

# pipes

pipes owns durable engineering tasks, runs, agent steps, and their evidence.

Before choosing CLI calls, run `pipes --help`, then inspect the relevant command's help. Treat the installed CLI help as the source of truth instead of relying on remembered syntax.

- Preserve the user's requested repository, workflow, and outcome.
- Create an ad-hoc task when the user asks to delegate new work, carrying the requested outcome and supporting context into pipes.
- Infer the current repository when pipes supports it; ask only when the choice is ambiguous.
- Perform mutations only when requested. Never accept, dismiss, push, merge, or publish implicitly.
- Return the affected task or run identifier, current status, and any action the user still owns.
- Retrieve detailed transcripts and artifacts only when they are needed.

When pipes launches you as a worker, follow the supplied step assignment and use its scoped result tool. Do not operate sibling steps or the wider queue.
