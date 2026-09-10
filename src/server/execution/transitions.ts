import { Effect } from 'effect';
import { PipesError, Run } from '../../protocol/pipes';
import { nextExecutionState, type ExecutionEvent } from '../../protocol/execution-state';
import type { ExecutionContext } from './context';

export const transition = (run: Run, event: ExecutionEvent): Run => {
  const status = nextExecutionState(run.status, event);
  if (!status) {
    throw new PipesError({ message: `Cannot ${event} a ${run.status} run.` });
  }
  return { ...run, status };
};

export const currentRun = Effect.fn('Execution.currentRun')(function* (
  ctx: ExecutionContext,
  taskId: string,
) {
  return (
    ctx.activeRuns.get(taskId)?.() ??
    (yield* ctx.store.snapshot).runs?.findLast((run) => run.taskId === taskId)
  );
});

export const ownedRun = Effect.fn('Execution.ownedRun')(function* (
  ctx: ExecutionContext,
  taskId: string,
  token: string,
) {
  const run = (yield* ctx.store.snapshot).runs?.findLast((run) => run.taskId === taskId);
  if (!run || run.status !== 'human_owned' || run.handoffToken !== token) {
    return yield* new PipesError({
      message: 'Interactive ownership no longer matches this session.',
    });
  }
  return run;
});
