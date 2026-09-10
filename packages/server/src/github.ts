import { Context, Effect, Layer, Schedule, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { GitHubRepository } from '@pipes/protocol';
import { GitHubConnection, PipesError, type Repository } from '@pipes/protocol';
import { Store } from './store';
import { identity, loginComplete, loginStart, requestError } from './github/auth';
import type { GitHubContext } from './github/context';
import { intake, startup } from './github/intake';
import { clone, configurationFor, inspect, repositories } from './github/repos';
import { eligible, GitHubIssue, routeWorkflow, validSignature } from './github/schemas';
import { get } from './github/auth';
import { webhook } from './github/webhook';

export { eligible, GitHubIssue, routeWorkflow, validSignature };

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
      const runContext = yield* Effect.context<never>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const ctx: GitHubContext = {
        client,
        clientId: 'Iv23li6GPuxwdLMQ3bjo',
        credentialFile: resolve(store.dataDirectory, 'github-token.json'),
        runContext,
        spawner,
        store,
      };
      return GitHub.of({
        attach: Effect.fn('GitHub.attach')(function* (input) {
          const name = yield* Schema.decodeEffect(GitHubRepository)(input.repository).pipe(
            Effect.mapError(requestError),
          );
          yield* identity(ctx);
          yield* get(ctx, `/repos/${name}`);
          const config = yield* configurationFor(ctx, input.path);
          if (!config || !Object.hasOwn(config.workflows, input.workflow)) {
            return yield* new PipesError({
              message: 'Configure a workflow in this repository first.',
            });
          }
          if (config.github) {
            const configured = [
              config.github.workflow,
              ...(config.github.routes?.map((route) => route.workflow) ?? []),
            ].filter((workflow) => workflow !== undefined);
            if (
              config.github.repository.toLowerCase() !== name.toLowerCase() ||
              (configured.length > 0 && !configured.includes(input.workflow))
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
          yield* intake(ctx, repository.id);
          return repository;
        }),
        clone: (repository, directory) => clone(ctx, repository, directory),
        identity: identity(ctx).pipe(Effect.map((user) => user.login)),
        inspect: (path) => inspect(ctx, path),
        intake: (repositoryId) => intake(ctx, repositoryId),
        loginComplete: (input) => loginComplete(ctx, input),
        loginStart: loginStart(ctx),
        repositories: repositories(ctx),
        startup: startup(ctx),
        webhook: (request) => webhook(ctx, request),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
