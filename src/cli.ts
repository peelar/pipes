#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Console, Effect } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, ensureServer, settings } from './client/connection';
import { decodeConfig } from './config';
import { Brief, PipesError, Title } from './protocol/pipes';

const connection = settings();
const config = Command.make(
  'config',
  { path: Argument.string('path').pipe(Argument.withDefault('.')) },
  Effect.fn(function* ({ path }) {
    const filename = resolve(path, '.pipes/pipes.ts');
    const module = yield* Effect.tryPromise({
      catch: (error) => new PipesError({ message: `Cannot load ${filename}: ${String(error)}` }),
      try: () => import(pathToFileURL(filename).href),
    });
    const resolved = yield* decodeConfig(module.default).pipe(
      Effect.mapError(
        (error) => new PipesError({ message: `Invalid ${filename}: ${error.message}` }),
      ),
    );
    yield* Console.log(JSON.stringify(resolved, null, 2));
  }),
).pipe(
  Command.withDescription(
    'Validate and print repository configuration (executes trusted TypeScript)',
  ),
);

const connect = Effect.gen(function* () {
  yield* ensureServer(connection);
  return yield* Client;
});

const register = Command.make(
  'register',
  { path: Argument.string('path') },
  Effect.fn(function* ({ path }) {
    const client = yield* connect;
    yield* Console.log(JSON.stringify(yield* client.register({ path: resolve(path) }), null, 2));
  }),
);

const submit = Command.make(
  'submit',
  {
    brief: Flag.string('brief').pipe(Flag.withDefault(''), Flag.withSchema(Brief)),
    repo: Flag.string('repo').pipe(Flag.withDescription('Registered repository ID')),
    title: Argument.string('title').pipe(Argument.withSchema(Title)),
  },
  Effect.fn(function* ({ brief, repo, title }) {
    const client = yield* connect;
    yield* Console.log(
      JSON.stringify(yield* client.submit({ brief, repositoryId: repo, title }), null, 2),
    );
  }),
);

const list = Command.make(
  'list',
  { json: Flag.boolean('json') },
  Effect.fn(function* ({ json }) {
    const client = yield* connect;
    const snapshot = yield* client.snapshot();
    yield* Console.log(
      json
        ? JSON.stringify(snapshot, null, 2)
        : snapshot.tasks.map((task) => `${task.id}  ${task.status}  ${task.title}`).join('\n') ||
            'No tasks yet.',
    );
  }),
);

const shutdown = Command.make(
  'shutdown',
  {},
  Effect.fn(function* () {
    yield* ensureServer(connection, false);
    const client = yield* Client;
    yield* client.shutdown();
    yield* Console.log('Pipes server stopped.');
  }),
);

Command.make(
  'pipes',
  {},
  Effect.fn(function* () {
    if (!process.stdin.isTTY) {
      return yield* new PipesError({
        message: 'The TUI needs a terminal. Use pipes --help for CLI commands.',
      });
    }
    yield* ensureServer(connection);
    yield* Effect.tryPromise({
      catch: (error) => new PipesError({ message: String(error) }),
      try: async () => {
        const { launch } = await import('./tui/app');
        await launch(connection);
      },
    });
  }),
).pipe(
  Command.withDescription('Persistent local engineering task queue'),
  Command.withSubcommands([config, register, submit, list, shutdown]),
  Command.run({ version: '0.0.1' }),
  Effect.provide([Client.layer(connection), BunServices.layer]),
  BunRuntime.runMain,
);
