#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Deferred, Effect, Layer } from 'effect';
import { HttpEffect } from 'effect/unstable/http';
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc';
import { join } from 'node:path';
import { settings, type Connection } from './client/connection';
import { PipesError, PipesRpcs } from './protocol/pipes';
import { Store } from './server/store';
import { checkCodexConfig, probeCodex, setupCodex } from './server/codex';

export const serve = Effect.fn('serve')(function* (connection: Connection) {
  const stopped = yield* Deferred.make<void>();
  const handlers = PipesRpcs.toLayer(
    Effect.gen(function* () {
      const store = yield* Store;
      return {
        codexProbe: probeCodex,
        codexSetup: setupCodex,
        configCheck: ({ path }) => checkCodexConfig(path),
        register: ({ path }) => store.register(path),
        shutdown: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        snapshot: () => store.snapshot,
        submit: (input) => store.submit(input),
        watch: () => store.watch,
      };
    }),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(
      handlers.pipe(Layer.provide(Store.layer(join(connection.directory, 'pipes.sqlite')))),
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
  yield* Deferred.await(stopped);
  yield* Effect.sleep('100 millis');
});

if (import.meta.main) {
  serve(settings()).pipe(Effect.scoped, Effect.provide(BunServices.layer), BunRuntime.runMain);
}
