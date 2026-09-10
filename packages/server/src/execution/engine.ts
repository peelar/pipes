import { Effect, Fiber } from 'effect';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Attempt, PipesError, type Run } from '@pipes/protocol';
import { failure } from '../errors';
import type { ExecutionContext } from './context';
import { applyFailureCause } from './outcome';
import { buildStepPrompt } from './prompt';
import { transition } from './transitions';

export const execute = Effect.fn('Execution.execute')(function* (
  ctx: ExecutionContext,
  initial: Run,
  repository: string,
) {
  let run = initial;
  let prepared = false;
  ctx.activeRuns.set(run.taskId, () => run);
  const save = () => ctx.store.saveRun(run);
  const work = Effect.gen(function* () {
    run = { ...transition(run, 'begin'), workerStopped: false };
    yield* save();
    const remaining = run.configuration.workflows[run.workflow]!.steps.filter(
      (step) =>
        run.attempts.findLast((attempt) => attempt.step === step.name)?.status !== 'completed',
    );
    const checked = new Set<string>();
    for (const step of remaining) {
      const key = JSON.stringify(step.agent);
      if (!checked.has(key)) {
        yield* ctx.environment.probe(repository, step.agent);
        checked.add(key);
      }
    }
    if (!(yield* ctx.environment.exists(run))) {
      yield* ctx.environment.prepare(repository, run);
      if (run.configuration.setup) {
        yield* ctx.environment.setup(run.workspace, run.configuration.setup);
      }
    }
    prepared = true;
    for (const step of remaining) {
      const attemptId = crypto.randomUUID();
      const transcript = join(ctx.directory, 'artifacts', run.id, `${attemptId}.jsonl`);
      yield* Effect.try({
        catch: failure,
        try: () => mkdirSync(join(ctx.directory, 'artifacts', run.id), { recursive: true }),
      });
      let attempt: typeof Attempt.Type = {
        id: attemptId,
        status: 'running',
        step: step.name,
        transcript,
      };
      run = { ...run, attempts: [...run.attempts, attempt] };
      const saveAttempt = () => {
        run = { ...run, attempts: [...run.attempts.slice(0, -1), attempt] };
        return save();
      };
      yield* save();
      yield* Effect.gen(function* () {
        const prompt = buildStepPrompt(run, step, attemptId);
        yield* ctx.environment.execute({
          agent: step.agent,
          path: run.workspace,
          prompt,
          report: async (result) => {
            if (attempt.result || ctx.cancellations.has(run.taskId)) {
              throw new Error('This attempt already reported a result or has ended.');
            }
            attempt = { ...attempt, result };
            await Effect.runPromiseWith(ctx.runContext)(saveAttempt());
          },
          session: (session) => {
            attempt = { ...attempt, ...session };
            return saveAttempt();
          },
          update: (notification) =>
            appendFileSync(transcript, `${JSON.stringify(notification)}\n`, {
              mode: 0o600,
            }),
        });
        if (!attempt.result) {
          return yield* new PipesError({
            message: `Step ${step.name} ended without reporting a pipes result.`,
          });
        }
      }).pipe(ctx.slots.withPermit);
      attempt = { ...attempt, status: attempt.result!.status };
      yield* saveAttempt();
      run = { ...run, summary: attempt.result!.summary };
      if (attempt.result!.status !== 'completed') {
        run = transition(run, attempt.result!.status === 'blocked' ? 'block' : 'fail');
        return;
      }
    }
    run = transition(run, 'complete');
  });
  yield* Effect.uninterruptibleMask((restore) =>
    restore(work).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          run = applyFailureCause(run, cause, ctx.cancellations.has(run.taskId));
        }),
      ),
      Effect.andThen(
        Effect.gen(function* () {
          if (run.status === 'cancelling') {
            yield* save();
          }
          if (prepared) {
            yield* ctx.environment.checkpoint(run).pipe(
              Effect.tap((revision) =>
                Effect.sync(() => {
                  run = { ...run, revision };
                }),
              ),
              Effect.catch((error) =>
                Effect.sync(() => {
                  run = {
                    ...transition(run, 'fail'),
                    summary: `${run.summary}\nCheckpoint failed: ${error.message}`,
                  };
                }),
              ),
            );
            if (run.status === 'awaiting_acceptance') {
              yield* ctx.environment.cleanup(repository, run).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    run = {
                      ...transition(run, 'fail'),
                      summary: `${run.summary}\nCleanup failed: ${error.message}`,
                    };
                  }),
                ),
              );
            }
          }
          if (run.status === 'cancelling') {
            run = transition(run, 'stopped');
          }
          run = { ...run, workerStopped: true };
          yield* save();
        }),
      ),
    ),
  );
}, Effect.catchCause(Effect.logError));

export const launch = Effect.fn('Execution.launch')(function* (
  ctx: ExecutionContext,
  run: Run,
  repository: string,
) {
  const fiber = yield* execute(ctx, run, repository).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        ctx.workers.delete(run.taskId);
        ctx.cancellations.delete(run.taskId);
        ctx.activeRuns.delete(run.taskId);
      }),
    ),
    Effect.forkIn(ctx.scope),
  );
  ctx.workers.set(run.taskId, fiber);
});

export const stop = Effect.fn('Execution.stop')(function* (ctx: ExecutionContext, taskId: string) {
  const fiber = ctx.workers.get(taskId);
  if (!fiber) {
    return yield* new PipesError({ message: 'No active worker for this task.' });
  }
  yield* Fiber.interrupt(fiber);
});
