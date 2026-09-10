import { Effect, Schema } from 'effect';
import { ChildProcess } from 'effect/unstable/process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { decodeConfig, githubRepository, GitHubRepository } from '@pipes/protocol';
import { PipesError, type Repository } from '@pipes/protocol';
import { selfCommand } from '../self';
import { credential, get, identity, requestError } from './auth';
import type { GitHubContext } from './context';

export const configurationFor = Effect.fn('GitHub.configurationFor')(function* (
  ctx: GitHubContext,
  path: string,
) {
  if (!existsSync(resolve(path, '.pipes/config.ts'))) {
    return undefined;
  }
  const { args, executable } = selfCommand(['config', path]);
  const output = yield* ctx.spawner.string(ChildProcess.make(executable, args));
  const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(output);
  return yield* decodeConfig(value);
}, Effect.mapError(requestError));

export const policyFor = (ctx: GitHubContext, repository: Repository) =>
  configurationFor(ctx, repository.path).pipe(Effect.map((config) => config?.github));

export const inspect = Effect.fn('GitHub.inspect')(function* (ctx: GitHubContext, path: string) {
  const names = yield* ctx.spawner.lines(ChildProcess.make('git', ['-C', path, 'remote']));
  const remotes: Array<string> = [];
  for (const name of names) {
    const url = yield* ctx.spawner.string(
      ChildProcess.make('git', ['-C', path, 'config', '--get', `remote.${name}.url`]),
    );
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(url)) {
      continue;
    }
    const remote = yield* Effect.try(() => githubRepository(url)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (remote && !remotes.includes(remote)) {
      remotes.push(remote);
    }
  }
  const config = yield* configurationFor(ctx, path);
  return {
    ...(config?.github ? { policy: config.github } : {}),
    remotes,
    workflows: Object.keys(config?.workflows ?? {}),
  };
}, Effect.mapError(requestError));

export const clone = Effect.fn('GitHub.clone')(function* (
  ctx: GitHubContext,
  repository: string,
  directory: string,
) {
  const name = yield* Schema.decodeEffect(GitHubRepository)(repository);
  yield* identity(ctx);
  yield* get(ctx, `/repos/${name}`);
  const path = resolve(directory, 'repositories', name.toLowerCase());
  if (existsSync(path)) {
    const origin = yield* ctx.spawner.string(
      ChildProcess.make('git', ['-C', path, 'config', '--get', 'remote.origin.url']),
    );
    const existing = yield* Effect.try(() => githubRepository(origin));
    if (existing.toLowerCase() !== name.toLowerCase()) {
      return yield* new PipesError({
        message: 'Managed clone path already belongs to another repository.',
      });
    }
    return path;
  }
  yield* Effect.tryPromise({
    catch: requestError,
    try: () => mkdir(dirname(path), { recursive: true }),
  });
  const token = yield* credential(ctx);
  const code = yield* ctx.spawner
    .exitCode(
      ChildProcess.make(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'init.templateDir=',
          'clone',
          '--',
          `https://github.com/${name}.git`,
          path,
        ],
        {
          env: {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
            GIT_TERMINAL_PROMPT: '0',
          },
          extendEnv: true,
          stderr: 'ignore',
          stdout: 'ignore',
        },
      ),
    )
    .pipe(Effect.timeout('5 minutes'));
  if (code !== 0) {
    return yield* new PipesError({
      message: 'Clone failed. Check GitHub access and the managed clone directory, then retry.',
    });
  }
  return path;
}, Effect.mapError(requestError));

export const repositories = Effect.fn('GitHub.repositories')(function* (ctx: GitHubContext) {
  return yield* Effect.gen(function* () {
    const user = yield* identity(ctx);
    const repositories: Array<string> = [];
    for (let page = 1; ; page++) {
      const entries = yield* get(
        ctx,
        `/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`,
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ full_name: GitHubRepository }))),
        ),
      );
      repositories.push(...entries.map((entry) => entry.full_name));
      if (entries.length < 100) {
        return { login: user.login, repositories };
      }
    }
  }).pipe(Effect.mapError(requestError));
});
