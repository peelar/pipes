import { Console, Effect } from 'effect';
import { Argument, Command } from 'effect/unstable/cli';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
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
    let resolved = yield* decodeConfig(module.default).pipe(
      Effect.mapError(
        (error) => new PipesError({ message: `Invalid ${filename}: ${error.message}` }),
      ),
    );
    const githubFile = resolve(path, '.pipes/github.ts');
    if (existsSync(githubFile)) {
      if (resolved.github) {
        return yield* new PipesError({
          message: 'Define GitHub intake in pipes.ts or github.ts, not both.',
        });
      }
      const github = yield* Effect.tryPromise({
        catch: () => new PipesError({ message: `Cannot load ${githubFile}` }),
        try: () => import(pathToFileURL(githubFile).href),
      });
      resolved = yield* decodeConfig({ ...resolved, github: github.default });
    }
    yield* Console.log(JSON.stringify(resolved, null, 2));
  }),
).pipe(
  Command.withDescription(
    'Validate and print repository configuration (executes trusted TypeScript)',
  ),
);
