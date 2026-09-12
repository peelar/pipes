import { Effect } from 'effect';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { findStep, PipesError, Run, StepResult, validateStepResult } from '@pipes/protocol';
import { nextExecutionState } from '@pipes/protocol';
import { failure } from '../errors';
import type { ExecutionContext } from './context';
import { stop } from './engine';
import { currentRun, ownedRun, transition } from './transitions';

export const jumpIn = Effect.fn('Execution.jumpIn')(function* (
  ctx: ExecutionContext,
  taskId: string,
  confirmedStopped = false,
) {
  let run = yield* currentRun(ctx, taskId);
  if (!run || run.handoffToken || !nextExecutionState(run.status, 'jumpIn')) {
    return yield* new PipesError({
      message:
        'This task cannot be claimed, or already has an interactive session. If its client crashed, confirm Codex has stopped and use pipes handoff-close --confirm-stopped.',
    });
  }
  yield* ctx.environment.handoffSession(run);
  if (ctx.workers.has(taskId)) {
    yield* stop(ctx, taskId);
    run = (yield* ctx.store.snapshot).runs!.findLast((run) => run.taskId === taskId)!;
  }
  if ((!run.workerStopped && !confirmedStopped) || !(yield* ctx.environment.exists(run))) {
    return yield* new PipesError({
      message: `Cannot confirm the detached worker stopped or its worktree exists. After confirming the previous worker stopped, use pipes jump-in ${taskId} --confirm-stopped. No interactive writer was launched.`,
    });
  }
  const latest = run.attempts.at(-1)!;
  if (!latest.sessionId || !nextExecutionState(run.status, 'jumpIn')) {
    return yield* new PipesError({
      message: 'Execution changed while stopping. Inspect its result before jumping in.',
    });
  }
  const session = yield* ctx.environment.handoffSession(run);
  const id = crypto.randomUUID();
  const transcript = join(ctx.directory, 'artifacts', run.id, `${id}.jsonl`);
  yield* Effect.try({
    catch: failure,
    try: () =>
      appendFileSync(
        transcript,
        `${JSON.stringify({ prompt: `Interactive handoff of task ${taskId}, run ${run!.id}, step ${latest.step}, Codex session ${latest.sessionId}. Earlier evidence: ${latest.transcript}` })}\n`,
        { mode: 0o600 },
      ),
  });
  run = {
    ...transition(run, 'jumpIn'),
    attempts: [
      ...run.attempts,
      {
        ...session,
        id,
        status: 'interrupted',
        step: latest.step,
        transcript,
      },
    ],
    handoffToken: crypto.randomUUID(),
    summary:
      'Human owns this step. Close Codex, then explicitly return control with [s] or pipes start.',
    workerStopped: true,
  };
  yield* ctx.store.saveRun(run);
  return new Run(run);
});

export const handoffReport = Effect.fn('Execution.handoffReport')(function* (
  ctx: ExecutionContext,
  input: { result: typeof StepResult.Type; taskId: string; token: string },
) {
  const run = yield* ownedRun(ctx, input.taskId, input.token);
  const attempt = run.attempts.at(-1)!;
  if (attempt.result) {
    return yield* new PipesError({
      message: 'This interactive attempt already reported a result.',
    });
  }
  const step = findStep(run.configuration.workflows[run.workflow]?.steps, attempt.step);
  const invalid = validateStepResult(step, input.result);
  if (invalid) {
    return yield* new PipesError({ message: invalid });
  }
  yield* ctx.store.saveRun({
    ...run,
    attempts: [...run.attempts.slice(0, -1), { ...attempt, result: input.result }],
    summary: input.result.summary,
  });
});

export const handoffClose = Effect.fn('Execution.handoffClose')(function* (
  ctx: ExecutionContext,
  input: { successful: boolean; taskId: string; token: string },
) {
  const run = yield* ownedRun(ctx, input.taskId, input.token);
  const revision = yield* ctx.environment.checkpoint(run);
  const { handoffToken: _token, ...held } = run;
  const attempt = run.attempts.at(-1)!;
  yield* ctx.store.saveRun({
    ...held,
    attempts: [
      ...run.attempts.slice(0, -1),
      {
        ...attempt,
        status: input.successful && attempt.result ? attempt.result.status : 'interrupted',
      },
    ],
    revision,
  });
});
