import { DateTime, Effect } from 'effect';
import { PipesError, Run } from '../../protocol/pipes';
import { nextExecutionState } from '../../protocol/execution-state';
import type { ExecutionContext } from './context';
import { launch, stop } from './engine';
import { currentRun, transition } from './transitions';

export const start = Effect.fn('Execution.start')(function* (
  ctx: ExecutionContext,
  input: { taskId: string; workflow?: string },
) {
  const snapshot = yield* ctx.store.snapshot;
  const task = snapshot.tasks.find((task) => task.id === input.taskId);
  const repository = snapshot.repositories.find(
    (repository) => repository.id === task?.repositoryId,
  );
  if (!task || !repository) {
    return yield* new PipesError({ message: 'Task or repository not found.' });
  }
  const previous = snapshot.runs?.findLast((run) => run.taskId === task.id);
  if (previous && (previous.handoffToken || !nextExecutionState(previous.status, 'start'))) {
    return yield* new PipesError({
      message: 'This task already has a run. Inspect its result before further work.',
    });
  }
  if (previous && previous.status !== 'cancelled') {
    const run = new Run(transition(previous, 'start'));
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* ctx.store.saveRun(run);
        yield* launch(ctx, run, repository.path);
      }),
    );
    return run;
  }
  const configuration = yield* ctx.environment.configuration(repository.path);
  const workflow =
    input.workflow ??
    task.workflow ??
    previous?.workflow ??
    (Object.keys(configuration.workflows).length === 1
      ? Object.keys(configuration.workflows)[0]
      : undefined);
  if (!workflow || !Object.hasOwn(configuration.workflows, workflow)) {
    return yield* new PipesError({
      message: `Choose a configured workflow with --workflow: ${Object.keys(configuration.workflows).join(', ')}`,
    });
  }
  const id = crypto.randomUUID().slice(0, 8);
  const run = new Run({
    attempts: [],
    baseRevision: yield* ctx.environment.git(repository.path, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${configuration.base ?? 'HEAD'}^{commit}`,
    ]),
    branch: `pipes/${id}`,
    brief: task.brief,
    configuration,
    createdAt: DateTime.formatIso(yield* DateTime.now),
    id,
    status: 'queued',
    summary: '',
    taskId: task.id,
    title: task.title,
    workflow,
    workspace: ctx.environment.workspace(ctx.directory, id),
  });
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      yield* ctx.store.saveRun(run, true);
      yield* launch(ctx, run, repository.path);
    }),
  );
  return run;
});

export const cancelActive = Effect.fn('Execution.cancelActive')(function* (
  ctx: ExecutionContext,
  taskId: string,
) {
  const run = yield* currentRun(ctx, taskId);
  if (!run || !nextExecutionState(run.status, 'cancel') || !ctx.workers.has(taskId)) {
    return yield* new PipesError({ message: 'Only ongoing execution can be cancelled.' });
  }
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      ctx.cancellations.add(taskId);
      yield* stop(ctx, taskId);
    }),
  );
});

export const cancel = Effect.fn('Execution.cancel')(function* (
  ctx: ExecutionContext,
  taskId: string,
) {
  yield* cancelActive(ctx, taskId);
});

export const discard = Effect.fn('Execution.discard')(function* (
  ctx: ExecutionContext,
  taskId: string,
) {
  const run = (yield* ctx.store.snapshot).runs?.findLast((run) => run.taskId === taskId);
  if (run?.handoffToken) {
    return yield* new PipesError({
      message: 'Close the interactive handoff before discarding this task.',
    });
  }
  if (ctx.workers.has(taskId)) {
    yield* cancelActive(ctx, taskId);
  }
  yield* ctx.store.discard(taskId);
});
