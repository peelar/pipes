import { Cause, Context, DateTime, Effect, Fiber, Layer, Schema, Semaphore } from 'effect';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Attempt, PipesError, Run, StepResult } from '../protocol/pipes';
import { nextExecutionState, type ExecutionEvent } from '../protocol/execution-state';
import { Environment } from './environment';
import { Store } from './store';

const failure = (error: unknown) =>
  error instanceof PipesError ? error : new PipesError({ message: String(error) });

const transition = (run: Run, event: ExecutionEvent): Run => {
  const status = nextExecutionState(run.status, event);
  if (!status) {
    throw new PipesError({ message: `Cannot ${event} a ${run.status} run.` });
  }
  return { ...run, status };
};

export class Execution extends Context.Service<
  Execution,
  {
    cancel: (taskId: string) => Effect.Effect<void, PipesError>;
    discard: (taskId: string) => Effect.Effect<void, PipesError>;
    handoffClose: (input: {
      successful: boolean;
      taskId: string;
      token: string;
    }) => Effect.Effect<void, PipesError>;
    handoffReport: (input: {
      result: typeof StepResult.Type;
      taskId: string;
      token: string;
    }) => Effect.Effect<void, PipesError>;
    jumpIn: (taskId: string, confirmedStopped?: boolean) => Effect.Effect<Run, PipesError>;
    recover: Effect.Effect<void, PipesError>;
    start: (input: { taskId: string; workflow?: string }) => Effect.Effect<Run, PipesError>;
    stop: (taskId: string) => Effect.Effect<void, PipesError>;
  }
>()('pipes/Execution') {
  static layer = (directory: string) =>
    Layer.effect(
      Execution,
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const context = yield* Effect.context<never>();
        const store = yield* Store;
        const environment = yield* Environment;
        const limit = yield* Schema.decodeEffect(
          Schema.Int.check(Schema.isBetween({ maximum: 64, minimum: 1 })),
        )(Number(process.env.PIPES_CONCURRENCY ?? 1));
        const slots = yield* Semaphore.make(limit);
        // ponytail: one start lock is enough until run creation becomes a throughput bottleneck.
        const starting = yield* Semaphore.make(1);
        const workers = new Map<string, Fiber.Fiber<void, never>>();
        const cancellations = new Set<string>();
        const activeRuns = new Map<string, () => Run>();
        const currentRun = Effect.fn('Execution.currentRun')(function* (taskId: string) {
          return (
            activeRuns.get(taskId)?.() ??
            (yield* store.snapshot).runs?.findLast((run) => run.taskId === taskId)
          );
        });

        const execute = Effect.fn('Execution.execute')(function* (
          initial: Run,
          repository: string,
        ) {
          let run = initial;
          let prepared = false;
          activeRuns.set(run.taskId, () => run);
          const save = () => store.saveRun(run);
          const work = Effect.gen(function* () {
            run = { ...transition(run, 'begin'), workerStopped: false };
            yield* save();
            const remaining = run.configuration.workflows[run.workflow]!.steps.filter(
              (step) =>
                run.attempts.findLast((attempt) => attempt.step === step.name)?.status !==
                'completed',
            );
            const checked = new Set<string>();
            for (const step of remaining) {
              const key = JSON.stringify(step.agent);
              if (!checked.has(key)) {
                yield* environment.probe(repository, step.agent);
                checked.add(key);
              }
            }
            if (!(yield* environment.exists(run))) {
              yield* environment.prepare(repository, run);
              if (run.configuration.setup) {
                yield* environment.setup(run.workspace, run.configuration.setup);
              }
            }
            prepared = true;
            for (const step of remaining) {
              const attemptId = crypto.randomUUID();
              const transcript = join(directory, 'artifacts', run.id, `${attemptId}.jsonl`);
              yield* Effect.try({
                catch: failure,
                try: () => mkdirSync(join(directory, 'artifacts', run.id), { recursive: true }),
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
                const prompt = [
                  `Pipes task ${run.taskId}, run ${run.id}, step ${step.name}, attempt ${attemptId}.`,
                  `Task: ${run.title}\n${run.brief}`,
                  `Assignment:\n${step.prompt}`,
                  `Previous results:\n${run.attempts
                    .slice(0, -1)
                    .map(
                      (previous) =>
                        `${previous.step}: ${previous.result?.summary ?? ''}\nTranscript: ${previous.transcript}`,
                    )
                    .join('\n\n')}`,
                  'Work locally. Do not push, publish, merge, or act on other steps. Submit completed, blocked, or failed with a summary using the Pipes report_result MCP tool, then end your turn. Include changes, checks, and unresolved concerns. A plain final message does not complete the step.',
                ].join('\n\n');
                yield* environment.execute({
                  agent: step.agent,
                  path: run.workspace,
                  prompt,
                  report: async (result) => {
                    if (attempt.result || cancellations.has(run.taskId)) {
                      throw new Error('This attempt already reported a result or has ended.');
                    }
                    attempt = { ...attempt, result };
                    await Effect.runPromiseWith(context)(saveAttempt());
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
                    message: `Step ${step.name} ended without reporting a Pipes result.`,
                  });
                }
              }).pipe(slots.withPermit);
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
                  const status = Cause.hasInterrupts(cause)
                    ? ('interrupted' as const)
                    : ('failed' as const);
                  run = {
                    ...run,
                    attempts: run.attempts.map((attempt) =>
                      attempt.status === 'running' ? { ...attempt, status } : attempt,
                    ),
                    status:
                      cancellations.has(run.taskId) && Cause.hasInterrupts(cause)
                        ? transition(run, 'cancel').status
                        : transition(run, status === 'interrupted' ? 'interrupt' : 'fail').status,
                    summary: Cause.hasInterrupts(cause)
                      ? cancellations.has(run.taskId)
                        ? 'Execution cancelled. Workspace and evidence preserved.'
                        : 'Worker stopped. Inspect the preserved workspace before continuing.'
                      : Cause.pretty(cause),
                  };
                }),
              ),
              Effect.andThen(
                Effect.gen(function* () {
                  if (run.status === 'cancelling') {
                    yield* save();
                  }
                  if (prepared) {
                    yield* environment.checkpoint(run).pipe(
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
                      yield* environment.cleanup(repository, run).pipe(
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

        const launch = Effect.fn('Execution.launch')(function* (run: Run, repository: string) {
          const fiber = yield* execute(run, repository).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                workers.delete(run.taskId);
                cancellations.delete(run.taskId);
                activeRuns.delete(run.taskId);
              }),
            ),
            Effect.forkIn(scope),
          );
          workers.set(run.taskId, fiber);
        });

        const recover = Effect.gen(function* () {
          const snapshot = yield* store.snapshot;
          for (const previous of snapshot.runs ?? []) {
            const task = snapshot.tasks.find((task) => task.id === previous.taskId);
            const repository = snapshot.repositories.find(
              (repository) => repository.id === task?.repositoryId,
            );
            if (previous.status === 'queued' && repository) {
              yield* launch(previous, repository.path);
            } else if (['running', 'queued', 'cancelling'].includes(previous.status)) {
              // Never replay an invocation whose completion is uncertain after a server restart.
              yield* store.saveRun({
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

        const start = Effect.fn('Execution.start')(
          function* (input: { taskId: string; workflow?: string }) {
            const snapshot = yield* store.snapshot;
            const task = snapshot.tasks.find((task) => task.id === input.taskId);
            const repository = snapshot.repositories.find(
              (repository) => repository.id === task?.repositoryId,
            );
            if (!task || !repository) {
              return yield* new PipesError({ message: 'Task or repository not found.' });
            }
            const previous = snapshot.runs?.findLast((run) => run.taskId === task.id);
            if (
              previous &&
              (previous.handoffToken || !nextExecutionState(previous.status, 'start'))
            ) {
              return yield* new PipesError({
                message: 'This task already has a run. Inspect its result before further work.',
              });
            }
            if (previous && previous.status !== 'cancelled') {
              const run = new Run(transition(previous, 'start'));
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* store.saveRun(run);
                  yield* launch(run, repository.path);
                }),
              );
              return run;
            }
            const configuration = yield* environment.configuration(repository.path);
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
              baseRevision: yield* environment.git(repository.path, [
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
              workspace: environment.workspace(directory, id),
            });
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* store.saveRun(run, true);
                yield* launch(run, repository.path);
              }),
            );
            return run;
          },
          starting.withPermit,
          Effect.mapError(failure),
        );
        const stop = Effect.fn('Execution.stop')(function* (taskId: string) {
          const fiber = workers.get(taskId);
          if (!fiber) {
            return yield* new PipesError({ message: 'No active worker for this task.' });
          }
          yield* Fiber.interrupt(fiber);
        });
        const cancelActive = Effect.fn('Execution.cancelActive')(function* (taskId: string) {
          const run = yield* currentRun(taskId);
          if (!run || !nextExecutionState(run.status, 'cancel') || !workers.has(taskId)) {
            return yield* new PipesError({ message: 'Only ongoing execution can be cancelled.' });
          }
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              cancellations.add(taskId);
              yield* stop(taskId);
            }),
          );
        });
        const cancel = Effect.fn('Execution.cancel')(function* (taskId: string) {
          yield* cancelActive(taskId);
        }, starting.withPermit);
        const discard = Effect.fn('Execution.discard')(function* (taskId: string) {
          const run = (yield* store.snapshot).runs?.findLast((run) => run.taskId === taskId);
          if (run?.handoffToken) {
            return yield* new PipesError({
              message: 'Close the interactive handoff before discarding this task.',
            });
          }
          if (workers.has(taskId)) {
            yield* cancelActive(taskId);
          }
          yield* store.discard(taskId);
        }, starting.withPermit);
        const jumpIn = Effect.fn('Execution.jumpIn')(
          function* (taskId: string, confirmedStopped = false) {
            let run = yield* currentRun(taskId);
            if (!run || run.handoffToken || !nextExecutionState(run.status, 'jumpIn')) {
              return yield* new PipesError({
                message:
                  'This task cannot be claimed, or already has an interactive session. If its client crashed, confirm Codex has stopped and use pipes handoff-close --confirm-stopped.',
              });
            }
            yield* environment.handoffSession(run);
            if (workers.has(taskId)) {
              yield* stop(taskId);
              run = (yield* store.snapshot).runs!.findLast((run) => run.taskId === taskId)!;
            }
            if ((!run.workerStopped && !confirmedStopped) || !(yield* environment.exists(run))) {
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
            const session = yield* environment.handoffSession(run);
            const id = crypto.randomUUID();
            const transcript = join(directory, 'artifacts', run.id, `${id}.jsonl`);
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
            yield* store.saveRun(run);
            return new Run(run);
          },
          starting.withPermit,
          Effect.uninterruptible,
        );
        const ownedRun = Effect.fn('Execution.ownedRun')(function* (taskId: string, token: string) {
          const run = (yield* store.snapshot).runs?.findLast((run) => run.taskId === taskId);
          if (!run || run.status !== 'human_owned' || run.handoffToken !== token) {
            return yield* new PipesError({
              message: 'Interactive ownership no longer matches this session.',
            });
          }
          return run;
        });
        const handoffReport = Effect.fn('Execution.handoffReport')(function* (input: {
          result: typeof StepResult.Type;
          taskId: string;
          token: string;
        }) {
          const run = yield* ownedRun(input.taskId, input.token);
          const attempt = run.attempts.at(-1)!;
          if (attempt.result) {
            return yield* new PipesError({
              message: 'This interactive attempt already reported a result.',
            });
          }
          yield* store.saveRun({
            ...run,
            attempts: [...run.attempts.slice(0, -1), { ...attempt, result: input.result }],
            summary: input.result.summary,
          });
        }, starting.withPermit);
        const handoffClose = Effect.fn('Execution.handoffClose')(
          function* (input: { successful: boolean; taskId: string; token: string }) {
            const run = yield* ownedRun(input.taskId, input.token);
            const revision = yield* environment.checkpoint(run);
            const { handoffToken: _token, ...held } = run;
            const attempt = run.attempts.at(-1)!;
            yield* store.saveRun({
              ...held,
              attempts: [
                ...run.attempts.slice(0, -1),
                {
                  ...attempt,
                  status:
                    input.successful && attempt.result ? attempt.result.status : 'interrupted',
                },
              ],
              revision,
            });
          },
          starting.withPermit,
          Effect.uninterruptible,
        );
        return Execution.of({
          cancel,
          discard,
          handoffClose,
          handoffReport,
          jumpIn,
          recover,
          start,
          stop,
        });
      }),
    );
}
