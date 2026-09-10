import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
  type McpServer,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { Effect, PlatformError, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexProbe, CodexSettings, PipesError } from '@pipes/protocol';
import { selfCommand } from './self';
import { version } from './version';

const authRequired = Schema.is(Schema.Struct({ code: Schema.Literal(-32_000) }));
const errorMessage = Schema.is(Schema.Struct({ message: Schema.String }));
export const acpError = (error: unknown) =>
  new PipesError({
    message: authRequired(error)
      ? 'Codex needs authentication. Run pipes agent login in another terminal, then retry. For API-key authentication, configure the adapter environment before starting pipesd.'
      : `Codex connection failed: ${errorMessage(error) ? error.message : String(error)}`,
  });

export const codexSkillPath = (home = homedir()) =>
  join(home, '.agents', 'skills', 'pipes', 'SKILL.md');

export const codexSkillInstalled = (home = homedir()) => existsSync(codexSkillPath(home));

// Phase 1 distribution expects a `codex` CLI on PATH; bundling the engine is deferred.
export const codexBinary = process.env.PIPES_CODEX_BIN ?? process.env.CODEX_PATH ?? 'codex';
export const codexMcp = (home: string, args: Array<string>) =>
  ChildProcess.make(codexBinary, ['mcp', ...args], {
    env: { CODEX_HOME: join(home, '.codex') },
    extendEnv: true,
  });

export const codexMcpInstalled = Effect.fn('codexMcpInstalled')(function* (home = homedir()) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(codexMcp(home, ['get', 'pipes', '--json'])).pipe(
    Effect.flatMap(
      Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ name: Schema.Literal('pipes') }))),
    ),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

function selector(options: ReadonlyArray<SessionConfigOption> | null | undefined, id: string) {
  const option = options?.find((item) => item.id === id);
  if (!option || option.type !== 'select') {
    throw new Error(`The adapter does not advertise ${id}. Update pipes to get a current adapter.`);
  }
  const choices = option.options.flatMap((item) => ('options' in item ? item.options : [item]));
  if (!choices.length) {
    throw new Error(
      `The adapter advertised no choices for ${id}. Check your Codex account and adapter installation.`,
    );
  }
  return { choices, currentValue: option.currentValue };
}

export const openCodex = Effect.fn('openCodex')(function* (
  input: typeof CodexProbe.Type,
  execution?: { mcpServers: Array<McpServer>; update: (notification: SessionNotification) => void },
) {
  const request = yield* Schema.decodeEffect(CodexProbe)(input).pipe(Effect.mapError(acpError));
  // The adapter ships inside the Pipes binary and uses the system Codex engine.
  const self = selfCommand(['__codex-acp']);
  const adapterCommand: ReadonlyArray<string> = request.command ?? [self.executable, ...self.args];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outgoing = new TransformStream<Uint8Array, Uint8Array>();
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(adapterCommand[0]!, adapterCommand.slice(1), {
        cwd: resolve(request.path),
        env: {
          CODEX_PATH: codexBinary,
          INITIAL_AGENT_MODE: execution ? 'agent-full-access' : 'read-only',
        },
        extendEnv: true,
        forceKillAfter: '2 seconds',
        stdin: Stream.fromReadableStream({
          evaluate: () => outgoing.readable,
          onError: (cause) =>
            PlatformError.systemError({
              _tag: 'Unknown',
              cause,
              method: 'stdin',
              module: 'ChildProcess',
            }),
        }),
        // Probe output can include account details. Never forward adapter stderr to the TUI.
        stderr: 'ignore',
      }),
    )
    .pipe(
      Effect.mapError(
        () =>
          new PipesError({
            message: `Cannot launch ${adapterCommand[0]} in ${request.path}. Check the repository directory and any custom command. The default adapter ships inside the pipes binary; update or reinstall pipes if launching it fails.`,
          }),
      ),
    );
  const incoming = yield* Stream.toReadableStreamEffect(handle.stdout);
  const connection = yield* Effect.acquireRelease(
    Effect.sync(() =>
      client({ name: 'pipes' })
        .onRequest('session/request_permission', ({ params }) => {
          const option = execution && params.options.find((option) => option.kind === 'allow_once');
          return {
            outcome: option
              ? { optionId: option.optionId, outcome: 'selected' as const }
              : { outcome: 'cancelled' as const },
          };
        })
        .onNotification('session/update', ({ params }) => execution?.update(params))
        .connect(ndJsonStream(outgoing.writable, incoming)),
    ),
    (connection) => Effect.sync(() => connection.close()),
  );
  const mcpInstalled = yield* codexMcpInstalled();
  const result = yield* Effect.tryPromise({
    catch: acpError,
    try: async () => {
      const initialized = await connection.agent.request('initialize', {
        clientCapabilities: {},
        clientInfo: { name: 'pipes', version },
        protocolVersion: PROTOCOL_VERSION,
      });
      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Unsupported ACP protocol version ${initialized.protocolVersion}.`);
      }
      const session = await connection.agent.request('session/new', {
        cwd: resolve(request.path),
        mcpServers: execution?.mcpServers ?? [],
      });
      let options = session.configOptions;
      for (const [id, value] of [
        ['model', request.model],
        ['reasoning_effort', request.reasoning],
      ] as const) {
        if (value === undefined) {
          continue;
        }
        if (!selector(options, id).choices.some((choice) => choice.value === value)) {
          throw new Error(`Unsupported ${id}: ${value}. Choose one of the advertised values.`);
        }
        const response = await connection.agent.request('session/set_config_option', {
          configId: id,
          sessionId: session.sessionId,
          value,
        });
        options = response.configOptions;
        if (selector(options, id).currentValue !== value) {
          throw new Error(`The adapter did not apply ${id}: ${value}.`);
        }
      }
      const model = selector(options, 'model');
      const reasoning = selector(options, 'reasoning_effort');
      if (request.model && model.currentValue !== request.model) {
        throw new Error('The adapter changed the selected model while applying reasoning.');
      }
      return {
        adapter: initialized.agentInfo
          ? `${initialized.agentInfo.name} ${initialized.agentInfo.version}`
          : 'Codex ACP',
        configurationExists: existsSync(resolve(request.path, '.pipes/config.ts')),
        mcpInstalled,
        model: model.currentValue,
        models: model.choices,
        reasoning: reasoning.currentValue,
        reasoningOptions: reasoning.choices,
        sessionId: session.sessionId,
        skillInstalled: codexSkillInstalled(),
      };
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: '30 seconds',
      orElse: () =>
        Effect.fail(
          new PipesError({
            message:
              'Codex connection timed out after 30 seconds. Check installation, authentication, and network access, then retry.',
          }),
        ),
    }),
  );
  const settings = yield* Schema.decodeEffect(CodexSettings)(result).pipe(
    Effect.mapError(acpError),
  );
  return { connection, sessionId: result.sessionId, settings };
});

export const probeCodex = Effect.fn('probeCodex')(function* (input: typeof CodexProbe.Type) {
  return (yield* openCodex(input)).settings;
}, Effect.scoped);
