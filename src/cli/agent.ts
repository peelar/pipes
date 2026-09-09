import { Console, Effect, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { resolve } from 'node:path';
import { AgentCommand } from '../config';
import { PipesError } from '../protocol/pipes';
import { selfCommand } from '../self';
import { connect } from './connection';

export const agent = Command.make(
  'agent',
  {
    command: Flag.string('command').pipe(
      Flag.withDefault(''),
      Flag.withDescription('Override the bundled ACP command with a JSON array'),
    ),
    model: Flag.string('model').pipe(Flag.withDefault('')),
    path: Argument.string('path').pipe(Argument.withDefault('.')),
    reasoning: Flag.string('reasoning').pipe(Flag.withDefault('')),
    setup: Flag.boolean('setup').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Create the starter workflow; requires explicit model and reasoning'),
    ),
  },
  Effect.fn(function* ({ command, model, path, reasoning, setup }) {
    const launch = command
      ? yield* Schema.decodeEffect(Schema.fromJsonString(AgentCommand))(command).pipe(
          Effect.mapError(
            (error) => new PipesError({ message: `Invalid --command: ${error.message}` }),
          ),
        )
      : undefined;
    if (setup && (!model || !reasoning)) {
      return yield* new PipesError({
        message:
          '--setup requires --model and --reasoning. Run pipes agent first to discover their IDs.',
      });
    }
    const client = yield* connect;
    const input = {
      ...(launch && { command: launch }),
      path: resolve(path),
      ...(model && { model }),
      ...(reasoning && { reasoning }),
    };
    const result = setup
      ? yield* client.codexSetup({
          agent: { ...(launch && { command: launch }), model, provider: 'codex', reasoning },
          path: input.path,
        })
      : yield* client.codexProbe(input);
    yield* Console.log(JSON.stringify(result, null, 2));
  }),
).pipe(
  Command.withSubcommands([
    Command.make(
      'login',
      {},
      Effect.fn(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { args, executable } = selfCommand(['__codex-acp', 'cli', 'login']);
        const handle = yield* spawner.spawn(
          ChildProcess.make(executable, args, {
            stderr: 'inherit',
            stdin: 'inherit',
            stdout: 'inherit',
          }),
        );
        const code = yield* handle.exitCode;
        if (code !== 0) {
          return yield* new PipesError({
            message: 'Codex login failed. Try pipes agent login again.',
          });
        }
      }, Effect.scoped),
    ).pipe(Command.withDescription('Sign in using the bundled Codex CLI')),
  ]),
  Command.withDescription(
    'Check Codex authentication and discover or verify model and reasoning settings',
  ),
);
