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
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, decodeConfig } from '../config';
import { CodexProbe, CodexSettings, PipesError } from '../protocol/pipes';

const authRequired = Schema.is(Schema.Struct({ code: Schema.Literal(-32_000) }));
const errorMessage = Schema.is(Schema.Struct({ message: Schema.String }));
const acpError = (error: unknown) =>
  new PipesError({
    message: authRequired(error)
      ? 'Codex needs authentication. Run pipes agent login in another terminal, then retry. For API-key authentication, configure the adapter environment before starting pipesd.'
      : `Codex connection failed: ${errorMessage(error) ? error.message : String(error)}`,
  });

export const codexSkillPath = (home = homedir()) =>
  join(home, '.agents', 'skills', 'pipes', 'SKILL.md');

export const codexSkillInstalled = (home = homedir()) => existsSync(codexSkillPath(home));

const codexCommand = fileURLToPath(import.meta.resolve('@openai/codex/bin/codex.js'));
const pipesCommand = fileURLToPath(new URL('../cli.ts', import.meta.url));
const codexMcp = (home: string, args: Array<string>) =>
  ChildProcess.make(process.execPath, [codexCommand, 'mcp', ...args], {
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

export const installCodex = Effect.fn('installCodex')(function* (home = homedir()) {
  const filename = codexSkillPath(home);
  yield* Effect.tryPromise({
    catch: (error) =>
      new PipesError({
        message: `Could not install Pipes for Codex: ${String(error)}`,
      }),
    try: async () => {
      await mkdir(join(home, '.codex'), { recursive: true });
      await mkdir(dirname(filename), { recursive: true });
      try {
        await writeFile(
          filename,
          await Bun.file(new URL('../../skills/pipes/SKILL.md', import.meta.url)).text(),
          { flag: 'wx' },
        );
      } catch (error) {
        if (!Schema.is(Schema.Struct({ code: Schema.Literal('EEXIST') }))(error)) {
          throw error;
        }
      }
    },
  });
  if (!(yield* codexMcpInstalled(home))) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* spawner
      .string(codexMcp(home, ['add', 'pipes', '--', process.execPath, pipesCommand, 'mcp']))
      .pipe(
        Effect.mapError(
          (error) =>
            new PipesError({ message: `Could not install the Pipes MCP server: ${String(error)}` }),
        ),
      );
    if (!(yield* codexMcpInstalled(home))) {
      return yield* new PipesError({ message: 'Could not install the Pipes MCP server.' });
    }
  }
  return filename;
});

function selector(options: ReadonlyArray<SessionConfigOption> | null | undefined, id: string) {
  const option = options?.find((item) => item.id === id);
  if (!option || option.type !== 'select') {
    throw new Error(`The adapter does not advertise ${id}. Update Pipes to get a current adapter.`);
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
  const command = request.command ?? [
    process.execPath,
    fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp')),
  ];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outgoing = new TransformStream<Uint8Array, Uint8Array>();
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(command[0]!, command.slice(1), {
        cwd: resolve(request.path),
        env: { INITIAL_AGENT_MODE: execution ? 'agent-full-access' : 'read-only' },
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
            message: `Cannot launch ${command[0]} in ${request.path}. Check the repository directory and any custom command. The default adapter is included with Pipes; reinstall Pipes if its files are missing.`,
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
        clientInfo: { name: 'pipes', version: '0.0.1' },
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

export const setupCodex = Effect.fn('setupCodex')(
  function* (input: { agent: typeof Agent.Type; path: string }) {
    const agent = yield* Schema.decodeEffect(Agent)(input.agent).pipe(Effect.mapError(acpError));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = (yield* spawner.string(
      ChildProcess.make('git', ['-C', input.path, 'rev-parse', '--show-toplevel']),
    )).trim();
    if (!root) {
      return yield* new PipesError({
        message: 'Choose a Git repository before creating the starter workflow.',
      });
    }
    yield* probeCodex({ ...agent, path: root });
    const configuration = yield* decodeConfig({
      workflows: {
        'plan-implement-review': {
          steps: [
            {
              agent,
              name: 'plan',
              prompt:
                'Read the task and repository. Write an actionable implementation plan, including checks and open questions.',
            },
            {
              agent,
              name: 'implement',
              prompt:
                'Implement the plan for the task. Run the relevant checks and summarize changes and any unresolved concerns.',
            },
            {
              agent,
              name: 'review',
              prompt:
                'Review the implementation against the task and plan. Check correctness and test coverage. Report findings with file references and any unresolved concerns.',
            },
          ],
        },
      },
    });
    const filename = join(root, '.pipes/config.ts');
    yield* Effect.tryPromise({
      catch: () =>
        new PipesError({
          message: `Could not create ${filename}. Existing files are never overwritten; copy the selected agent settings into your configuration.`,
        }),
      try: async () => {
        await mkdir(join(root, '.pipes'), { recursive: true });
        await writeFile(filename, `export default ${JSON.stringify(configuration, null, 2)};\n`, {
          flag: 'wx',
        });
      },
    });
    return filename;
  },
  Effect.mapError((error) => (error instanceof PipesError ? error : acpError(error))),
);

export const checkCodexConfig = Effect.fn('checkCodexConfig')(
  function* (path: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // A fresh process also reloads imported workflow files after the user edits them.
    const output = yield* spawner.string(
      ChildProcess.make(process.execPath, [resolve(import.meta.dir, '../cli.ts'), 'config', path]),
    );
    const configuration = yield* decodeConfig(
      yield* Effect.try({
        catch: (error) => new PipesError({ message: output.trim() || String(error) }),
        try: () => JSON.parse(output),
      }),
    );
    const checked = new Set<string>();
    for (const workflow of Object.values(configuration.workflows)) {
      for (const { agent } of workflow.steps) {
        const key = JSON.stringify(agent);
        if (!checked.has(key)) {
          yield* probeCodex({ ...agent, path });
          checked.add(key);
        }
      }
    }
    return `Validated workflows: ${Object.keys(configuration.workflows).join(', ')}`;
  },
  Effect.mapError(
    (error) => new PipesError({ message: `Configuration check failed: ${String(error)}` }),
  ),
);
