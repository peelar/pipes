import { Context, Effect, Layer, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PipesError, type Run } from '../protocol/pipes';

export class Environment extends Context.Service<
  Environment,
  {
    checkpoint: (run: Run) => Effect.Effect<string, PipesError>;
    git: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string, PipesError>;
    prepare: (repository: string, run: Run) => Effect.Effect<void, PipesError>;
    setup: (cwd: string, command: ReadonlyArray<string>) => Effect.Effect<void, PipesError>;
  }
>()('pipes/Environment') {
  static layer = Layer.effect(
    Environment,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = Effect.fn('Environment.git')(
        function* (cwd: string, args: ReadonlyArray<string>) {
          const handle = yield* spawner.spawn(
            ChildProcess.make('git', ['-C', cwd, ...args], { stderr: 'ignore' }),
          );
          const output = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
          if ((yield* handle.exitCode) !== 0) {
            return yield* new PipesError({
              message: `git ${args[0]} failed in ${cwd}. Workspace changes are preserved.`,
            });
          }
          return output.trim();
        },
        Effect.scoped,
        Effect.mapError((error) =>
          error instanceof PipesError ? error : new PipesError({ message: String(error) }),
        ),
      );
      const prepare = Effect.fn('Environment.prepare')(function* (repository: string, run: Run) {
        yield* Effect.tryPromise({
          catch: (error) => new PipesError({ message: String(error) }),
          try: () => mkdir(dirname(run.workspace), { recursive: true }),
        });
        yield* git(repository, [
          'worktree',
          'add',
          '-b',
          run.branch,
          run.workspace,
          run.baseRevision,
        ]);
      });
      const checkpoint = Effect.fn('Environment.checkpoint')(function* (run: Run) {
        yield* git(run.workspace, ['add', '-A']);
        if (yield* git(run.workspace, ['diff', '--cached', '--name-only'])) {
          yield* git(run.workspace, [
            '-c',
            'user.name=Pipes',
            '-c',
            'user.email=pipes@localhost',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgSign=false',
            'commit',
            '-m',
            `Pipes checkpoint ${run.id}`,
          ]);
        }
        return yield* git(run.workspace, ['rev-parse', 'HEAD']);
      });
      const setup = Effect.fn('Environment.setup')(
        function* (cwd: string, command: ReadonlyArray<string>) {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command[0]!, command.slice(1), {
              cwd,
              stderr: 'ignore',
              stdout: 'ignore',
            }),
          );
          if ((yield* handle.exitCode) !== 0) {
            return yield* new PipesError({
              message: 'Repository setup failed; no agent was started.',
            });
          }
        },
        Effect.scoped,
        Effect.mapError((error) =>
          error instanceof PipesError ? error : new PipesError({ message: String(error) }),
        ),
      );
      return Environment.of({ checkpoint, git, prepare, setup });
    }),
  );
}
