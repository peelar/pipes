import { Effect, ManagedRuntime, Schema } from 'effect';
import { readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, ensureServer, settings } from '../src/client/connection';

const connection = settings();
const runtime = ManagedRuntime.make(Client.layer(connection));
const onboardingFile = join(connection.directory, 'onboarding.json');

const onboarding = await readFile(onboardingFile, 'utf8')
  .then((json) =>
    Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ path: Schema.String })))(json),
  )
  .catch((error: unknown) => {
    if (Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)) {
      return undefined;
    }
    throw error;
  });

try {
  const running = await runtime.runPromise(
    ensureServer(connection, false).pipe(
      Effect.as(true),
      Effect.catchTag('PipesError', (error) =>
        error.message === 'Pipes server is not running.'
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    ),
  );
  if (running) {
    await runtime.runPromise(Effect.flatMap(Client, (client) => client.shutdown()));
  }
  let stopped = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`${connection.url}/health`, { signal: AbortSignal.timeout(500) });
    } catch (error) {
      if (
        !Schema.is(Schema.Struct({ code: Schema.Literals(['ECONNREFUSED', 'ConnectionRefused']) }))(
          error,
        )
      ) {
        throw error;
      }
      stopped = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!stopped) {
    throw new Error('Server did not stop; database was not deleted.');
  }
  for (const name of [
    'pipes.sqlite',
    'pipes.sqlite-wal',
    'pipes.sqlite-shm',
    'pipes.sqlite-journal',
  ]) {
    await rm(join(connection.directory, name), { force: true });
  }
  if (onboarding) {
    const configDirectory = join(onboarding.path, '.pipes');
    await rm(join(configDirectory, 'config.ts'), { force: true });
    await rmdir(configDirectory).catch(() => {});
  }
  await rm(onboardingFile, { force: true });
  process.stdout.write(`Reset Pipes state in ${connection.directory}. No backup was created.\n`);
} finally {
  await runtime.dispose();
}
