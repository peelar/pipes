import { Effect } from 'effect';
import type { ExecutionContext } from './context';
import { launch } from './engine';
import { transition } from './transitions';

export const recover = Effect.fn('Execution.recover')(function* (ctx: ExecutionContext) {
  const snapshot = yield* ctx.store.snapshot;
  for (const previous of snapshot.runs ?? []) {
    const task = snapshot.tasks.find((task) => task.id === previous.taskId);
    const repository = snapshot.repositories.find(
      (repository) => repository.id === task?.repositoryId,
    );
    if (previous.status === 'queued' && repository) {
      yield* launch(ctx, previous, repository.path);
    } else if (['running', 'queued', 'cancelling'].includes(previous.status)) {
      // Never replay an invocation whose completion is uncertain after a server restart.
      yield* ctx.store.saveRun({
        ...previous,
        attempts: previous.attempts.map((attempt) =>
          attempt.status === 'running' ? { ...attempt, status: 'interrupted' } : attempt,
        ),
        status: transition(previous, 'interrupt').status,
        summary:
          'Server restarted before execution completed. Inspect the workspace and confirm the previous worker stopped before further work.',
        workerStopped: false,
      });
    }
  }
});
