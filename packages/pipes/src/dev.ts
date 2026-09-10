import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Effect, Logger } from 'effect';
import { join } from 'node:path';
import { ensureServer, settings } from './client/connection';
import { Client, type Connection } from '@pipes/protocol';
import { ObservabilityLayer } from './observability';
import { PipesError } from '@pipes/protocol';
import { serve } from './server';
import { launch } from './launch';

const running = (connection: Connection) =>
  ensureServer(connection, false).pipe(
    Effect.as(true),
    Effect.catchTag('PipesError', (error) =>
      error.message === 'pipes server is not running.' ? Effect.succeed(false) : Effect.fail(error),
    ),
  );

const waitForServer = Effect.fn('dev.waitForServer')(function* (
  connection: Connection,
  expected: boolean,
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((yield* running(connection)) === expected) {
      return;
    }
    yield* Effect.sleep('100 millis');
  }
  return yield* new PipesError({
    message: `Development server did not ${expected ? 'start' : 'stop'}. See server.log.`,
  });
});

export const develop = Effect.fn('develop')(function* (
  connection: Connection,
  frontend: (connection: Connection, signal: AbortSignal) => Promise<void> = launch,
) {
  yield* Effect.gen(function* () {
    if (yield* running(connection)) {
      const client = yield* Client;
      yield* client.shutdown();
      yield* waitForServer(connection, false);
    }
    // One import graph and process: Bun watch reloads both halves together.
    yield* Effect.raceFirst(
      serve(connection).pipe(
        Effect.scoped,
        Effect.provide(
          Logger.layer([
            Logger.toFile(Logger.formatJson, join(connection.directory, 'server.log'), {
              mode: 0o600,
            }),
            Logger.tracerLogger,
          ]),
        ),
      ),
      waitForServer(connection, true).pipe(
        Effect.andThen(
          Effect.tryPromise({
            catch: (error) => new PipesError({ message: String(error) }),
            try: (signal) => frontend(connection, signal),
          }),
        ),
      ),
    );
  }).pipe(Effect.provide(Client.layer(connection)));
}, Effect.scoped);

if (import.meta.main) {
  if (!process.stdin.isTTY) {
    throw new Error('Development mode needs a terminal. Use pipes --help for CLI commands.');
  }
  develop(settings()).pipe(
    Effect.provide([BunServices.layer, ObservabilityLayer]),
    BunRuntime.runMain,
  );
}
