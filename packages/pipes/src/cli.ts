#!/usr/bin/env bun
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { Command } from 'effect/unstable/cli';
import { ensureServer } from './client/connection';
import { Client } from '@pipes/protocol';
import { agent } from './cli/agent';
import {
  cancel,
  conversation,
  github,
  handoffClose,
  jumpIn,
  list,
  register,
  shutdown,
  start,
  stop,
  submit,
} from './cli/commands';
import { config } from './cli/config';
import { connection } from './cli/connection';
import { mcp } from './cli/mcp';
import { upgrade } from './cli/upgrade';
import { PipesError } from '@pipes/protocol';
import { ObservabilityLayer } from './observability';
import { version } from '@pipes/server/version';

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
        const { launch } = await import('./launch');
        await launch(connection);
      },
    });
  }),
).pipe(
  Command.withDescription('Persistent local engineering task queue'),
  Command.withSubcommands([
    agent,
    config,
    github,
    register,
    submit,
    list,
    Command.make('mcp', {}, mcp).pipe(
      Command.withDescription('Run the pipes MCP server over stdio'),
    ),
    start,
    stop,
    cancel,
    conversation,
    jumpIn,
    handoffClose,
    shutdown,
    upgrade,
  ]),
  Command.run({ version }),
  Effect.provide([Client.layer(connection), BunServices.layer, ObservabilityLayer]),
  BunRuntime.runMain,
);
