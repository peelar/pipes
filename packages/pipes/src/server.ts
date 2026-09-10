#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Deferred, Effect, Layer } from 'effect';
import { HttpEffect } from 'effect/unstable/http';
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc';
import { join } from 'node:path';
import { settings } from './client/connection';
import { type Connection } from '@pipes/protocol';
import { PipesError, PipesRpcs } from '@pipes/protocol';
import { Execution } from '@pipes/server/execution';
import { Environment } from '@pipes/server/environment';
import { Store } from '@pipes/server/store';
import { GitHub } from '@pipes/server/github';
import { checkCodexConfig, installCodex, probeCodex, setupCodex } from '@pipes/server/codex';
import { ObservabilityLayer } from './observability';
import { readConversation } from '@pipes/server/conversation';

export const serve = Effect.fn('serve')(function* (connection: Connection) {
  const stopped = yield* Deferred.make<void>();
  const services = yield* Layer.build(
    Layer.merge(GitHub.layer, Execution.layer(connection.directory)).pipe(
      Layer.provide(Environment.layer),
      Layer.provideMerge(Store.layer(join(connection.directory, 'pipes.sqlite'))),
    ),
  );
  const github = yield* GitHub.pipe(Effect.provide(services));
  const handlers = PipesRpcs.toLayer(
    Effect.gen(function* () {
      const store = yield* Store;
      const execution = yield* Execution;
      return {
        cancel: ({ taskId }) => execution.cancel(taskId),
        codexInstall: () => installCodex(),
        codexProbe: probeCodex,
        codexSetup: setupCodex,
        configCheck: ({ path }) => checkCodexConfig(path),
        conversation: ({ taskId }) =>
          Effect.gen(function* () {
            const run = (yield* store.snapshot).runs?.findLast((run) => run.taskId === taskId);
            if (!run) {
              return yield* new PipesError({ message: 'This task has no execution conversation.' });
            }
            return yield* readConversation(run);
          }),
        discard: ({ taskId }) => execution.discard(taskId),
        githubAttach: (input) => github.attach(input),
        githubClone: ({ repository }) => github.clone(repository, connection.directory),
        githubIdentity: () => github.identity,
        githubInspect: ({ path }) => github.inspect(path),
        githubIntake: ({ repositoryId }) => github.intake(repositoryId),
        githubLoginComplete: (input) => github.loginComplete(input),
        githubLoginStart: () => github.loginStart,
        githubRepositories: () => github.repositories,
        handoffClose: execution.handoffClose,
        handoffReport: execution.handoffReport,
        jumpIn: ({ confirmedStopped, taskId }) => execution.jumpIn(taskId, confirmedStopped),
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
        start: execution.start,
        stop: ({ taskId }) => execution.stop(taskId),
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
  let ready = false;
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
            if (!ready) {
              return new Response('Starting', { status: 503 });
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
  yield* Effect.flatMap(Execution, (execution) => execution.recover).pipe(Effect.provide(services));
  ready = true;
  yield* Effect.logInfo(`pipes listening on ${connection.url}`);
  yield* Layer.build(GitHub.deliveryLayer.pipe(Layer.provide(Layer.succeedContext(services))));
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
