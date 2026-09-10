import { Context, Effect, Fiber, Layer, Schema, Semaphore } from 'effect';
import { PipesError, Run, StepResult } from '@pipes/protocol';
import { Environment } from './environment';
import { failure } from './errors';
import { Store } from './store';
import type { ExecutionContext } from './execution/context';
import { stop } from './execution/engine';
import { handoffClose, handoffReport, jumpIn } from './execution/handoff';
import { cancel, discard, start } from './execution/lifecycle';
import { recover } from './execution/recovery';

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
        const runContext = yield* Effect.context<never>();
        const store = yield* Store;
        const environment = yield* Environment;
        const limit = yield* Schema.decodeEffect(
          Schema.Int.check(Schema.isBetween({ maximum: 64, minimum: 1 })),
        )(Number(process.env.PIPES_CONCURRENCY ?? 1));
        const slots = yield* Semaphore.make(limit);
        // ponytail: one start lock is enough until run creation becomes a throughput bottleneck.
        const starting = yield* Semaphore.make(1);
        const ctx: ExecutionContext = {
          activeRuns: new Map<string, () => Run>(),
          cancellations: new Set<string>(),
          directory,
          environment,
          runContext,
          scope,
          slots,
          starting,
          store,
          workers: new Map<string, Fiber.Fiber<void, never>>(),
        };
        return Execution.of({
          cancel: (taskId) => starting.withPermit(cancel(ctx, taskId)),
          discard: (taskId) => starting.withPermit(discard(ctx, taskId)),
          handoffClose: (input) =>
            Effect.uninterruptible(starting.withPermit(handoffClose(ctx, input))),
          handoffReport: (input) => starting.withPermit(handoffReport(ctx, input)),
          jumpIn: (taskId, confirmedStopped) =>
            Effect.uninterruptible(starting.withPermit(jumpIn(ctx, taskId, confirmedStopped))),
          recover: recover(ctx),
          start: (input) => starting.withPermit(start(ctx, input)).pipe(Effect.mapError(failure)),
          stop: (taskId) => stop(ctx, taskId),
        });
      }),
    );
}
