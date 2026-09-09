import { Context, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { decodeConfig, githubRepository, GitHubRepository, type Config } from '../config';
import { Brief, GitHubConnection, PipesError, Title, type Repository } from '../protocol/pipes';
import { Store } from './store';

export const GitHubIssue = Schema.Struct({
  assignees: Schema.Array(Schema.Struct({ id: Schema.Int })),
  body: Schema.NullOr(Brief),
  id: Schema.Int,
  number: Schema.Int,
  pull_request: Schema.optionalKey(Schema.Unknown),
  state: Schema.Literals(['open', 'closed']),
  title: Title,
});

export const eligible = (
  issue: typeof GitHubIssue.Type,
  policy: NonNullable<Config['github']>,
  userId: number,
) =>
  issue.pull_request === undefined &&
  ((policy.state ?? 'open') === 'all' || issue.state === (policy.state ?? 'open')) &&
  (policy.assigned_to_me === false || issue.assignees.some((user) => user.id === userId));

export const validSignature = (body: string, signature: string | null, secret: string) => {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
};

const Webhook = Schema.Struct({
  issue: Schema.Struct({ number: Schema.Int }),
  repository: Schema.Struct({
    full_name: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  }),
});

const failure = (error?: unknown) =>
  Schema.is(PipesError)(error)
    ? error
    : new PipesError({
        message:
          'GitHub intake failed. Check the token, repository access, and intake configuration.',
      });

export class GitHub extends Context.Service<
  GitHub,
  {
    attach: (input: {
      path: string;
      repository: string;
      workflow: string;
    }) => Effect.Effect<Repository, PipesError>;
    clone: (repository: string, directory: string) => Effect.Effect<string, PipesError>;
    identity: Effect.Effect<string, PipesError>;
    inspect: (path: string) => Effect.Effect<typeof GitHubConnection.Type, PipesError>;
    intake: (repositoryId: string) => Effect.Effect<number, PipesError>;
    repositories: Effect.Effect<{ login: string; repositories: Array<string> }, PipesError>;
    startup: Effect.Effect<void>;
    webhook: (request: Request) => Promise<Response>;
  }
>()('pipes/GitHub') {
  // Delivery belongs to the source: a source layer may listen, poll, or do both.
  static deliveryLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const github = yield* GitHub;
      if (process.env.PIPES_GITHUB_WEBHOOK_SECRET) {
        const port = Number(process.env.PIPES_GITHUB_PORT ?? '9419');
        yield* Effect.acquireRelease(
          Effect.try({
            catch: () => new PipesError({ message: 'Cannot listen on GitHub webhook port.' }),
            try: () =>
              Bun.serve({
                fetch: (request) =>
                  new URL(request.url).pathname === '/github'
                    ? github.webhook(request)
                    : new Response('Not found', { status: 404 }),
                hostname: '127.0.0.1',
                maxRequestBodySize: 1024 * 1024,
                port,
              }),
          }),
          (server) => Effect.promise(() => server.stop(true)),
        );
        yield* Effect.logInfo(`GitHub webhook listening on 127.0.0.1:${port}/github`);
      }
      yield* github.startup.pipe(Effect.forkScoped);
    }),
  );

  static layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const store = yield* Store;
      const context = yield* Effect.context<never>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const credential = Effect.gen(function* () {
        const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
        if (token) {
          return token;
        }
        return yield* spawner
          .string(
            ChildProcess.make('gh', ['auth', 'token', '--hostname', 'github.com'], {
              stderr: 'ignore',
            }),
          )
          .pipe(
            Effect.map((value) => value.trim()),
            Effect.timeout('5 seconds'),
            Effect.mapError(
              () =>
                new PipesError({
                  message:
                    'Sign in with gh auth login, or set GH_TOKEN in the Pipes server environment, then retry.',
                }),
            ),
          );
      });
      const get = Effect.fn('GitHub.get')(function* (path: string) {
        const token = yield* credential;
        return yield* client
          .get(`https://api.github.com${path}`, {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${token}`,
              'X-GitHub-Api-Version': '2022-11-28',
            },
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
            Effect.timeout('30 seconds'),
            Effect.mapError(failure),
          );
      });
      const configurationFor = Effect.fn('GitHub.configurationFor')(function* (path: string) {
        if (!existsSync(resolve(path, '.pipes/pipes.ts'))) {
          return undefined;
        }
        const output = yield* spawner.string(
          ChildProcess.make(process.execPath, [
            resolve(import.meta.dir, '../cli.ts'),
            'config',
            path,
          ]),
        );
        const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(output);
        return yield* decodeConfig(value);
      }, Effect.mapError(failure));
      const policyFor = (repository: Repository) =>
        configurationFor(repository.path).pipe(Effect.map((config) => config?.github));
      const identity = get('/user').pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ id: Schema.Int, login: Schema.NonEmptyString }),
          ),
        ),
        Effect.mapError(failure),
      );
      const admit = Effect.fn('GitHub.admit')(function* (
        repository: Repository,
        policy: NonNullable<Config['github']>,
        userId: number,
        issue: typeof GitHubIssue.Type,
      ) {
        if (!eligible(issue, policy, userId)) {
          return 0;
        }
        yield* store.submit({
          brief: issue.body ?? '',
          repositoryId: repository.id,
          sourceId: `github:${issue.id}`,
          sourceUrl: `https://github.com/${policy.repository}/issues/${issue.number}`,
          title: issue.title,
          workflow: policy.workflow,
        });
        return 1;
      });
      const intake = Effect.fn('GitHub.intake')(function* (repositoryId: string) {
        const repository = (yield* store.snapshot).repositories.find(
          (entry) => entry.id === repositoryId,
        );
        if (!repository) {
          return yield* new PipesError({
            message: 'Register the repository before GitHub intake.',
          });
        }
        const policy = yield* policyFor(repository);
        if (!policy) {
          return 0;
        }
        const user = yield* identity;
        let matched = 0;
        for (let page = 1; ; page++) {
          const query = new URLSearchParams({
            direction: 'asc',
            page: String(page),
            per_page: '100',
            sort: 'created',
            state: policy.state ?? 'open',
          });
          if (policy.assigned_to_me !== false) {
            query.set('assignee', user.login);
          }
          const issues = yield* get(`/repos/${policy.repository}/issues?${query}`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(GitHubIssue))),
            Effect.mapError(failure),
          );
          for (const issue of issues) {
            matched += yield* admit(repository, policy, user.id, issue);
          }
          if (issues.length < 100) {
            return matched;
          }
        }
      });
      const receive = Effect.fn('GitHub.receive')(function* (body: string) {
        const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Webhook))(body).pipe(
          Effect.mapError(failure),
        );
        for (const repository of (yield* store.snapshot).repositories) {
          const policy = yield* policyFor(repository);
          if (
            !policy ||
            policy.repository.toLowerCase() !== payload.repository.full_name.toLowerCase()
          ) {
            continue;
          }
          const user = yield* identity;
          // Fetch current state so delayed webhook deliveries cannot admit a now-ineligible issue.
          const issue = yield* get(
            `/repos/${policy.repository}/issues/${payload.issue.number}`,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GitHubIssue)), Effect.mapError(failure));
          yield* admit(repository, policy, user.id, issue);
        }
      });
      return GitHub.of({
        attach: Effect.fn('GitHub.attach')(function* (input) {
          const name = yield* Schema.decodeEffect(GitHubRepository)(input.repository).pipe(
            Effect.mapError(failure),
          );
          yield* identity;
          yield* get(`/repos/${name}`);
          const config = yield* configurationFor(input.path);
          if (!config || !Object.hasOwn(config.workflows, input.workflow)) {
            return yield* new PipesError({
              message: 'Configure a workflow in this repository first.',
            });
          }
          if (config.github) {
            if (
              config.github.repository.toLowerCase() !== name.toLowerCase() ||
              config.github.workflow !== input.workflow
            ) {
              return yield* new PipesError({
                message:
                  'Existing GitHub policy differs. Edit its TypeScript configuration to change it.',
              });
            }
          } else {
            yield* Effect.tryPromise({
              catch: () =>
                new PipesError({
                  message:
                    'Cannot create .pipes/github.ts. Existing files are never overwritten; inspect the file and retry.',
                }),
              try: () =>
                writeFile(
                  resolve(input.path, '.pipes/github.ts'),
                  `export default ${JSON.stringify({ repository: name, workflow: input.workflow }, null, 2)};\n`,
                  { flag: 'wx' },
                ),
            });
          }
          const repository = yield* store.register(input.path);
          yield* intake(repository.id);
          return repository;
        }),
        clone: Effect.fn('GitHub.clone')(function* (repository, directory) {
          const name = yield* Schema.decodeEffect(GitHubRepository)(repository);
          yield* identity;
          yield* get(`/repos/${name}`);
          const path = resolve(directory, 'repositories', name.toLowerCase());
          if (existsSync(path)) {
            const origin = yield* spawner.string(
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
            catch: failure,
            try: () => mkdir(dirname(path), { recursive: true }),
          });
          const token = yield* credential;
          const code = yield* spawner
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
              message:
                'Clone failed. Check GitHub access and the managed clone directory, then retry.',
            });
          }
          return path;
        }, Effect.mapError(failure)),
        identity: identity.pipe(Effect.map((user) => user.login)),
        inspect: Effect.fn('GitHub.inspect')(function* (path) {
          const names = yield* spawner.lines(ChildProcess.make('git', ['-C', path, 'remote']));
          const remotes: Array<string> = [];
          for (const name of names) {
            const url = yield* spawner.string(
              ChildProcess.make('git', ['-C', path, 'config', '--get', `remote.${name}.url`]),
            );
            if (
              !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(url)
            ) {
              continue;
            }
            const remote = yield* Effect.try(() => githubRepository(url)).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            if (remote && !remotes.includes(remote)) {
              remotes.push(remote);
            }
          }
          const config = yield* configurationFor(path);
          return {
            ...(config?.github ? { policy: config.github } : {}),
            remotes,
            workflows: Object.keys(config?.workflows ?? {}),
          };
        }, Effect.mapError(failure)),
        intake,
        repositories: Effect.gen(function* () {
          const user = yield* identity;
          const repositories: Array<string> = [];
          for (let page = 1; ; page++) {
            const entries = yield* get(
              `/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`,
            ).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Array(Schema.Struct({ full_name: GitHubRepository })),
                ),
              ),
            );
            repositories.push(...entries.map((entry) => entry.full_name));
            if (entries.length < 100) {
              return { login: user.login, repositories };
            }
          }
        }).pipe(Effect.mapError(failure)),
        startup: Effect.gen(function* () {
          for (const repository of (yield* store.snapshot).repositories) {
            yield* intake(repository.id).pipe(
              Effect.catch((error) => Effect.logError(error.message)),
            );
          }
        }).pipe(Effect.catch((error) => Effect.logError(error.message))),
        webhook: async (request) => {
          const secret = process.env.PIPES_GITHUB_WEBHOOK_SECRET;
          if (!secret) {
            return new Response('GitHub webhook is not configured', { status: 503 });
          }
          if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
          }
          const body = await request.text();
          if (!validSignature(body, request.headers.get('x-hub-signature-256'), secret)) {
            return new Response('Forbidden', { status: 403 });
          }
          if (request.headers.get('x-github-event') !== 'issues') {
            return new Response('OK');
          }
          return Effect.runPromiseWith(context)(
            receive(body).pipe(
              Effect.as(new Response('OK')),
              Effect.catch((error) =>
                Effect.logError(error.message).pipe(
                  Effect.as(new Response('Intake failed; retry delivery', { status: 503 })),
                ),
              ),
            ),
          );
        },
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
