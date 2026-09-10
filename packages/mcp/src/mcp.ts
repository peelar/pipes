import { Effect, Option, Schema, Stdio, Stream } from 'effect';
import { relative } from 'node:path';
import { taskActions } from '@pipes/protocol';
import { Brief, PipesError, Title, type Run, type Snapshot, type Task } from '@pipes/protocol';

const Request = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite, Schema.Null])),
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const Call = Schema.Struct({
  arguments: Schema.optionalKey(Schema.Unknown),
  name: Schema.String,
});
const Empty = Schema.Struct({});
const TaskContext = Schema.Struct({
  includeConversation: Schema.optionalKey(Schema.Boolean),
  taskId: Schema.NonEmptyString,
});
const Recent = Schema.Struct({
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 50, minimum: 1 }))),
});
const RunTask = Schema.Struct({
  brief: Schema.optionalKey(Brief),
  repositoryId: Schema.optionalKey(Schema.NonEmptyString),
  title: Title,
  workflow: Schema.NonEmptyString,
});

const tools = [
  {
    description:
      'List work pipes cannot progress without human judgment. Follow with task_context for any item you will work on.',
    inputSchema: Schema.toJsonSchemaDocument(Empty).schema,
    name: 'attention',
  },
  {
    description:
      'Get the task, source, workflow position, prior results, evidence references, and valid next actions. Include the full conversation only when summaries are insufficient.',
    inputSchema: Schema.toJsonSchemaDocument(TaskContext).schema,
    name: 'task_context',
  },
  {
    description: 'List the most recently submitted work that has produced an outcome.',
    inputSchema: Schema.toJsonSchemaDocument(Recent).schema,
    name: 'recent_work',
  },
  {
    description:
      'Create a durable task and immediately run a configured workflow in a detached worker. Uses the current repository when unambiguous.',
    inputSchema: Schema.toJsonSchemaDocument(RunTask).schema,
    name: 'run_task',
  },
];

export interface McpClient {
  conversation: (input: { taskId: string }) => Effect.Effect<string, unknown>;
  snapshot: () => Effect.Effect<Snapshot, unknown>;
  start: (input: { taskId: string; workflow?: string }) => Effect.Effect<Run, unknown>;
  submit: (input: {
    brief: string;
    repositoryId: string;
    title: string;
    workflow?: string;
  }) => Effect.Effect<Task, unknown>;
}

const reply = (id: string | number | null, result: unknown) => ({ id, jsonrpc: '2.0', result });
const error = (id: string | number | null, code: number, message: string) => ({
  error: { code, message },
  id,
  jsonrpc: '2.0',
});
const content = (value: unknown) => ({
  content: [{ text: JSON.stringify(value, null, 2), type: 'text' }],
});

function context(snapshot: Snapshot, taskId: string) {
  const task = snapshot.tasks.find((task) => task.id === taskId);
  if (!task) {
    return;
  }
  const repository = snapshot.repositories.find(({ id }) => id === task.repositoryId);
  const run = snapshot.runs?.findLast((run) => run.taskId === task.id);
  const workflow = run?.configuration.workflows[run.workflow];
  const currentStep =
    run &&
    workflow?.steps.find(
      (step) =>
        run.attempts.findLast((attempt) => attempt.step === step.name)?.status !== 'completed',
    );
  return {
    attempts: run?.attempts.map(({ codexHome: _home, sessionId: _session, ...attempt }) => attempt),
    currentStep,
    nextActions: taskActions(run),
    repository,
    run: run && {
      baseRevision: run.baseRevision,
      branch: run.branch,
      createdAt: run.createdAt,
      id: run.id,
      revision: run.revision,
      status: run.status,
      summary: run.summary,
      updatedAt: run.updatedAt,
      workflow: run.workflow,
      workspace: run.workspace,
    },
    source: { id: task.sourceId, url: task.sourceUrl },
    task,
    workflow: workflow?.steps.map(({ agent, ...step }) => ({
      ...step,
      agent: { model: agent.model, provider: agent.provider, reasoning: agent.reasoning },
    })),
  };
}

const reason = (status: string | undefined) =>
  ({
    awaiting_acceptance: 'Review and accept or request changes.',
    blocked: 'Answer the blockage or take over the current step.',
    cancelled: 'Decide whether to dismiss the preserved work.',
    failed: 'Inspect the failure and decide how to continue.',
    human_owned: 'Finish the claimed step or explicitly return control.',
    interrupted: 'Confirm the previous writer stopped, then continue or take over.',
  })[status ?? ''] ?? 'Choose and start a configured workflow.';

function repositoryId(snapshot: Snapshot, requested: string | undefined, cwd: string) {
  if (requested) {
    return snapshot.repositories.some(({ id }) => id === requested) ? requested : undefined;
  }
  const matches = snapshot.repositories
    .filter(({ path }) => {
      const child = relative(path, cwd);
      return child === '' || (!child.startsWith('..') && !child.startsWith('/'));
    })
    .sort((left, right) => right.path.length - left.path.length);
  if (matches[0]) {
    return matches[0].id;
  }
  if (snapshot.repositories.length === 1) {
    return snapshot.repositories[0]!.id;
  }
  return undefined;
}

export const mcpMessage = Effect.fn('mcpMessage')(function* (
  client: McpClient,
  cwd: string,
  input: unknown,
) {
  const parsed = yield* Schema.decodeUnknownEffect(Request, { onExcessProperty: 'error' })(
    input,
  ).pipe(Effect.option);
  if (Option.isNone(parsed)) {
    return error(null, -32_700, 'Invalid JSON-RPC request');
  }
  const message = parsed.value;
  if (message.id === undefined) {
    return;
  }
  const id = message.id;
  if (message.method === 'initialize') {
    return reply(id, {
      capabilities: { tools: {} },
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'pipes', version: '0.0.1' },
    });
  }
  if (message.method === 'ping') {
    return reply(id, {});
  }
  if (message.method === 'tools/list') {
    return reply(id, { tools });
  }
  if (message.method !== 'tools/call') {
    return error(id, -32_601, 'Method not found');
  }
  return yield* Effect.gen(function* () {
    const call = yield* Schema.decodeUnknownEffect(Call, { onExcessProperty: 'error' })(
      message.params,
    );
    const snapshot = yield* client.snapshot();
    switch (call.name) {
      case 'attention': {
        yield* Schema.decodeEffect(Empty, { onExcessProperty: 'error' })(call.arguments ?? {});
        const items = snapshot.tasks.flatMap((task) => {
          const run = snapshot.runs?.findLast((run) => run.taskId === task.id);
          return run && ['queued', 'running', 'cancelling'].includes(run.status)
            ? []
            : [{ ...context(snapshot, task.id)!, attention: reason(run?.status) }];
        });
        return reply(id, content(items));
      }
      case 'task_context': {
        const input = yield* Schema.decodeUnknownEffect(TaskContext, {
          onExcessProperty: 'error',
        })(call.arguments);
        const value = context(snapshot, input.taskId);
        if (!value) {
          return yield* new PipesError({ message: 'Task not found.' });
        }
        return reply(
          id,
          content(
            input.includeConversation
              ? { ...value, conversation: yield* client.conversation({ taskId: input.taskId }) }
              : value,
          ),
        );
      }
      case 'recent_work': {
        const { limit = 10 } = yield* Schema.decodeEffect(Recent, {
          onExcessProperty: 'error',
        })(call.arguments ?? {});
        return reply(
          id,
          content(
            snapshot.tasks
              .map((task) => context(snapshot, task.id)!)
              .filter(({ attempts }) => attempts?.some(({ result }) => result))
              .sort((left, right) =>
                (right.run?.updatedAt ?? right.task.createdAt).localeCompare(
                  left.run?.updatedAt ?? left.task.createdAt,
                ),
              )
              .slice(0, limit),
          ),
        );
      }
      case 'run_task': {
        const input = yield* Schema.decodeUnknownEffect(RunTask, { onExcessProperty: 'error' })(
          call.arguments,
        );
        const selectedRepository = repositoryId(snapshot, input.repositoryId, cwd);
        if (!selectedRepository) {
          return yield* new PipesError({
            message: input.repositoryId
              ? 'Repository not found.'
              : 'Choose a registered repositoryId.',
          });
        }
        const task = yield* client.submit({
          brief: input.brief ?? '',
          repositoryId: selectedRepository,
          title: input.title,
          workflow: input.workflow,
        });
        const run = yield* client.start({ taskId: task.id, workflow: input.workflow }).pipe(
          Effect.mapError(
            (cause) =>
              new PipesError({
                message: `Task ${task.id} was created but could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
        );
        return reply(id, content({ run, task }));
      }
      default:
        return reply(id, {
          content: [{ text: `Unknown tool: ${call.name}`, type: 'text' }],
          isError: true,
        });
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        reply(id, {
          content: [{ text: error instanceof Error ? error.message : String(error), type: 'text' }],
          isError: true,
        }),
      ),
    ),
  );
});

export const runMcp = Effect.fn('mcp.run')(function* (client: McpClient, cwd: string) {
  const stdio = yield* Stdio.Stdio;
  yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.try({
          catch: (cause) => new PipesError({ message: String(cause) }),
          try: () => JSON.parse(line),
        }).pipe(Effect.option);
        const input = Option.getOrUndefined(parsed);
        const response = yield* mcpMessage(client, cwd, input);
        if (response !== undefined) {
          yield* Stream.make(`${JSON.stringify(response)}\n`).pipe(
            Stream.run(stdio.stdout({ endOnDone: false })),
          );
        }
      }),
    ),
  );
});
