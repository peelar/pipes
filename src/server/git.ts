import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PipesError, type Run } from '@pipes/protocol';
import { failure } from './errors';

type Spawner = ChildProcessSpawner.ChildProcessSpawner['Service'];

export const workspacePath = (directory: string, runId: string) =>
  join(directory, 'worktrees', runId);

export const git = Effect.fn('Git.git')(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
}, Effect.scoped);

export const workspaceExists = Effect.fn('Git.exists')(function* (run: Run) {
  return yield* Effect.try({ catch: failure, try: () => existsSync(run.workspace) });
});

export const prepareWorkspace = Effect.fn('Git.prepare')(function* (repository: string, run: Run) {
  yield* Effect.tryPromise({
    catch: (error) => new PipesError({ message: String(error) }),
    try: () => mkdir(dirname(run.workspace), { recursive: true }),
  });
  const branchExists = yield* git(repository, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${run.branch}`,
  ]).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false),
  );
  yield* git(
    repository,
    branchExists
      ? ['worktree', 'add', run.workspace, run.branch]
      : ['worktree', 'add', '-b', run.branch, run.workspace, run.baseRevision],
  );
});

export const checkpointWorkspace = Effect.fn('Git.checkpoint')(function* (run: Run) {
  yield* git(run.workspace, ['add', '-A']);
  if (yield* git(run.workspace, ['diff', '--cached', '--name-only'])) {
    yield* git(run.workspace, [
      '-c',
      'user.name=pipes',
      '-c',
      'user.email=pipes@localhost',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      `pipes checkpoint ${run.id}`,
    ]);
  }
  return yield* git(run.workspace, ['rev-parse', 'HEAD']);
});

export const cleanupWorkspace = Effect.fn('Git.cleanup')(function* (repository: string, run: Run) {
  if (['queued', 'running', 'cancelling', 'human_owned'].includes(run.status)) {
    return yield* new PipesError({
      message: 'Cannot clean up an active or human-owned environment.',
    });
  }
  if (existsSync(run.workspace)) {
    yield* git(repository, ['worktree', 'remove', '--force', '--', run.workspace]);
  }
});

export const makeGit = (spawner: Spawner) => {
  const provide = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(failure),
    );
  return {
    checkpoint: (run: Run) => provide(checkpointWorkspace(run)),
    cleanup: (repository: string, run: Run) => provide(cleanupWorkspace(repository, run)),
    exists: workspaceExists,
    git: (cwd: string, args: ReadonlyArray<string>) => provide(git(cwd, args)),
    prepare: (repository: string, run: Run) => provide(prepareWorkspace(repository, run)),
    workspace: workspacePath,
  };
};
