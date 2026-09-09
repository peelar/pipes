#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Deferred, Effect, Layer } from 'effect';
import { HttpEffect } from 'effect/unstable/http';
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc';
import { join } from 'node:path';
import { settings, type Connection } from './client/connection';
import { PipesError, PipesRpcs } from './protocol/pipes';
import { Store } from './server/store';
import { GitHub } from './server/github';
import { checkCodexConfig, probeCodex, setupCodex } from './server/codex';
import { ObservabilityLayer } from './observability';

export const serve = Effect.fn('serve')(function* (connection: Connection) {
  const stopped = yield* Deferred.make<void>();
  const services = yield* Layer.build(
    GitHub.layer.pipe(Layer.provideMerge(Store.layer(join(connection.directory, 'pipes.sqlite')))),
  );
  const github = yield* GitHub.pipe(Effect.provide(services));
  const handlers = PipesRpcs.toLayer(
    Effect.gen(function* () {
      const store = yield* Store;
      return {
        codexProbe: probeCodex,
        codexSetup: setupCodex,
        configCheck: ({ path }) => checkCodexConfig(path),
        githubAttach: (input) => github.attach(input),
        githubClone: ({ repository }) => github.clone(repository, connection.directory),
        githubIdentity: () => github.identity,
        githubInspect: ({ path }) => github.inspect(path),
        githubIntake: ({ repositoryId }) => github.intake(repositoryId),
        githubRepositories: () => github.repositories,
        register: ({ path }) =>
          store
            .register(path)
            .pipe(
              Effect.tap((repository) =>
                github
                  .intake(repository.id)
                  .pipe(Effect.catch((error) => Effect.logError(error.message))),
              ),
            ),
        shutdown: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        snapshot: () => store.snapshot,
        submit: (input) => store.submit(input),
        watch: () => store.watch,
      };
    }),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(
      handlers.pipe(Layer.provide(Layer.succeedContext(services))),
      RpcSerialization.layerNdjson,
    ),
  );
  const http = yield* RpcServer.toHttpEffect(PipesRpcs).pipe(Effect.provide(context));
  const handle = HttpEffect.toWebHandler(http);
  yield* Effect.acquireRelease(
    Effect.try({
      catch: (error) => new PipesError({ message: `Cannot listen: ${String(error)}` }),
      try: () =>
        Bun.serve({
          fetch: (request) => {
            if (
              request.headers.get('Authorization') !== `Bearer ${connection.token}` ||
              request.headers.has('origin')
            ) {
              return new Response('Forbidden', { status: 403 });
            }
            const path = new URL(request.url).pathname;
            if (path === '/health') {
              return new Response('pipes/1');
            }
            return (path === '/rpc' || path === '/rpc/') && request.method === 'POST'
              ? handle(request)
              : new Response('Not found', { status: 404 });
          },
          hostname: '127.0.0.1',
          idleTimeout: 0,
          port: connection.port,
        }),
    }),
    (server) => Effect.promise(() => server.stop(true)),
  );
  yield* Effect.logInfo(`Pipes listening on ${connection.url}`);
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
  yield* Deferred.await(stopped);
  yield* Effect.sleep('100 millis');
});

if (import.meta.main) {
  serve(settings()).pipe(
    Effect.scoped,
    Effect.provide([BunServices.layer, ObservabilityLayer]),
    BunRuntime.runMain,
  );
}
