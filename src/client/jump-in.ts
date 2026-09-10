import { Effect } from 'effect';
import { Client } from '@pipes/protocol';
import { PipesError } from '@pipes/protocol';
import { Environment } from '../server/environment';

export const jumpIn = Effect.fn('jumpIn')(
  function* (taskId: string, confirmedStopped = false) {
    if (!process.stdin.isTTY) {
      return yield* new PipesError({ message: 'Jump in requires an interactive terminal.' });
    }
    const client = yield* Client;
    const environment = yield* Environment;
    const context = yield* Effect.context<never>();
    let successful = false;
    const run = yield* Effect.acquireRelease(client.jumpIn({ confirmedStopped, taskId }), (run) =>
      client.handoffClose({ successful, taskId, token: run.handoffToken! }).pipe(
        Effect.mapError(
          (error) =>
            new PipesError({
              message: `Task remains locked: ${error.message}. After confirming Codex stopped, use pipes handoff-close ${taskId} --confirm-stopped.`,
            }),
        ),
        Effect.orDie,
      ),
    );
    const code = yield* environment.resume(run, (result) =>
      Effect.runPromiseWith(context)(
        client.handoffReport({ result, taskId, token: run.handoffToken! }),
      ),
    );
    successful = code === 0;
    if (!successful) {
      return yield* new PipesError({
        message: `Codex resume exited with ${code}. The task remains human-owned; jump in again or explicitly return control.`,
      });
    }
  },
  Effect.scoped,
  Effect.provide(Environment.layer),
);
