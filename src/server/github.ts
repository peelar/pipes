import { Context, Effect, Layer, Schedule, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { decodeConfig, githubRepository, GitHubRepository, type Config } from '../config';
import { Brief, GitHubConnection, PipesError, Title, type Repository } from '../protocol/pipes';
import { Store } from './store';
import { selfCommand } from '../self';

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

const DeviceAuthorization = Schema.Struct({
  device_code: Schema.NonEmptyString,
  interval: Schema.Int,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.NonEmptyString,
});

const OAuthToken = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.optionalKey(Schema.Int),
  refresh_token: Schema.optionalKey(Schema.NonEmptyString),
});

const OAuthError = Schema.Struct({
  error: Schema.NonEmptyString,
  error_description: Schema.optionalKey(Schema.String),
});

const SavedCredential = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  expiresAt: Schema.optionalKey(Schema.Int),
  refreshToken: Schema.optionalKey(Schema.NonEmptyString),
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
    loginComplete: (input: {
      deviceCode: string;
      interval: number;
    }) => Effect.Effect<string, PipesError>;
    loginStart: Effect.Effect<
      {
        deviceCode: string;
        interval: number;
        userCode: string;
        verificationUri: string;
      },
      PipesError
    >;
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
      // ponytail: full scans are enough for personal repositories; add cursors or ETags when API usage matters.
      yield* github.startup.pipe(Effect.repeat(Schedule.spaced('1 minute')), Effect.forkScoped);
    }),
  );

  static layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const store = yield* Store;
      const context = yield* Effect.context<never>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const clientId = 'Iv23li6GPuxwdLMQ3bjo';
      const credentialFile = resolve(store.dataDirectory, 'github-token.json');
      const oauth = Effect.fn('GitHub.oauth')(function* (
        path: 'device/code' | 'oauth/access_token',
        params: Record<string, string>,
      ) {
        return yield* client
          .post(`https://github.com/login/${path}`, {
            body: HttpBody.urlParams(params),
            headers: { Accept: 'application/json' },
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
            Effect.timeout('30 seconds'),
            Effect.mapError(failure),
          );
      });
      const saveCredential = Effect.fn('GitHub.saveCredential')(function* (
        token: typeof OAuthToken.Type,
      ) {
        // ponytail: a mode-0600 file is the cross-platform baseline; move it to an OS
        // credential store when Pipes adopts one that works on both macOS and Linux.
        yield* Effect.tryPromise({
          catch: failure,
          try: () =>
            writeFile(
              credentialFile,
              JSON.stringify({
                accessToken: token.access_token,
                ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
                ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
              }),
              { mode: 0o600 },
            ),
        });
        return token.access_token;
      });
      const credential = Effect.gen(function* () {
        const saved = yield* Effect.tryPromise({
          catch: () =>
            new PipesError({
              message: 'Sign in to GitHub through Pipes.',
            }),
          try: () => readFile(credentialFile, 'utf8'),
        }).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SavedCredential))),
          Effect.mapError(failure),
        );
        if (!saved.expiresAt || saved.expiresAt > Date.now() + 60_000) {
          return saved.accessToken;
        }
        if (!saved.refreshToken) {
          return yield* new PipesError({
            message: 'Your GitHub sign-in expired. Sign in again.',
          });
        }
        const refreshed = yield* oauth('oauth/access_token', {
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: saved.refreshToken,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Union([OAuthToken, OAuthError]))),
          Effect.mapError(failure),
        );
        if ('error' in refreshed) {
          return yield* new PipesError({
            message: refreshed.error_description ?? 'Your GitHub sign-in could not be refreshed.',
          });
        }
        return yield* saveCredential(refreshed);
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
        if (!existsSync(resolve(path, '.pipes/config.ts'))) {
          return undefined;
        }
        const { args, executable } = selfCommand(['config', path]);
        const output = yield* spawner.string(ChildProcess.make(executable, args));
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
        loginComplete: Effect.fn('GitHub.loginComplete')(function* (input) {
          let interval = Math.max(input.interval, 1);
          for (;;) {
            yield* Effect.sleep(`${interval} seconds`);
            const result = yield* oauth('oauth/access_token', {
              client_id: clientId,
              device_code: input.deviceCode,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Union([OAuthToken, OAuthError]))),
              Effect.mapError(failure),
            );
            if ('access_token' in result) {
              yield* saveCredential(result);
              return yield* identity.pipe(Effect.map((user) => user.login));
            }
            if (result.error === 'authorization_pending') {
              continue;
            }
            if (result.error === 'slow_down') {
              interval += 5;
              continue;
            }
            return yield* new PipesError({
              message: result.error_description ?? 'GitHub sign-in did not complete.',
            });
          }
        }),
        loginStart: Effect.gen(function* () {
          const result = yield* oauth('device/code', { client_id: clientId }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(DeviceAuthorization)),
            Effect.mapError(failure),
          );
          return {
            deviceCode: result.device_code,
            interval: result.interval,
            userCode: result.user_code,
            verificationUri: result.verification_uri,
          };
        }),
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
