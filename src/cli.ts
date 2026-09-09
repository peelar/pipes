#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { Command } from 'effect/unstable/cli';
import { Client, ensureServer } from './client/connection';
import { agent } from './cli/agent';
import { github, list, register, shutdown, submit } from './cli/commands';
import { config } from './cli/config';
import { connection } from './cli/connection';
import { PipesError } from './protocol/pipes';
import { ObservabilityLayer } from './observability';

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
  Command.withSubcommands([agent, config, github, register, submit, list, shutdown]),
  Command.run({ version: '0.0.1' }),
  Effect.provide([Client.layer(connection), BunServices.layer, ObservabilityLayer]),
  BunRuntime.runMain,
);
