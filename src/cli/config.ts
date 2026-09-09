import { Console, Effect } from 'effect';
import { Argument, Command } from 'effect/unstable/cli';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeConfig } from '../config';
import { PipesError } from '../protocol/pipes';

export const config = Command.make(
  'config',
  { path: Argument.string('path').pipe(Argument.withDefault('.')) },
  Effect.fn(function* ({ path }) {
    const filename = resolve(path, '.pipes/pipes.ts');
    const module = yield* Effect.tryPromise({
      catch: (error) => new PipesError({ message: `Cannot load ${filename}: ${String(error)}` }),
      try: () => import(pathToFileURL(filename).href),
    });
    const resolved = yield* decodeConfig(module.default).pipe(
      Effect.mapError(
        (error) => new PipesError({ message: `Invalid ${filename}: ${error.message}` }),
      ),
    );
    yield* Console.log(JSON.stringify(resolved, null, 2));
  }),
).pipe(
  Command.withDescription(
    'Validate and print repository configuration (executes trusted TypeScript)',
  ),
);
