import { Context, Effect, Layer, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Config, type Agent } from '@pipes/protocol';
import { PipesError, type Run, type StepResult } from '@pipes/protocol';
import { selfCommand } from './self';
import { codexBinary, openCodex, probeCodex } from './codex-acp';
import { failure } from './errors';
import { makeGit } from './git';
import { resultMcp } from '@pipes/mcp';

const codexHome = () => resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
type Session = { codexHome: string; sessionId: string };
type Report = (result: typeof StepResult.Type) => Promise<void>;

export function resumeArguments(run: Run, url: string) {
  const attempt = run.attempts.at(-1)!;
  return [
    codexBinary,
    'resume',
    attempt.sessionId!,
    '--cd',
    run.workspace,
    '-c',
    `mcp_servers.pipes_handoff.url=${JSON.stringify(url)}`,
    '-c',
    'mcp_servers.pipes_handoff.bearer_token_env_var="PIPES_HANDOFF_TOKEN"',
    `Interactive pipes handoff: task ${run.taskId}, run ${run.id}, step ${attempt.step}, attempt ${attempt.id}. The detached worker has stopped. The human owns this step; wait for their instructions. Earlier conversation and workspace are preserved. Use the refreshed pipes_handoff report_result tool; the detached attempt's endpoint has expired. Reporting records an outcome, but does not start sibling steps. Do not push, publish, or merge. Closing Codex leaves the task held; the human must explicitly return control in pipes.`,
  ];
}

export class Environment extends Context.Service<
  Environment,
  {
    checkpoint: (run: Run) => Effect.Effect<string, PipesError>;
    cleanup: (repository: string, run: Run) => Effect.Effect<void, PipesError>;
    configuration: (repository: string) => Effect.Effect<Config, PipesError>;
    execute: (input: {
      agent: typeof Agent.Type;
      path: string;
      prompt: string;
      report: Report;
      session: (session: Session) => Effect.Effect<void, PipesError>;
      update: (notification: unknown) => void;
    }) => Effect.Effect<void, PipesError>;
    exists: (run: Run) => Effect.Effect<boolean, PipesError>;
    git: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string, PipesError>;
    handoffSession: (run: Run) => Effect.Effect<Session, PipesError>;
    prepare: (repository: string, run: Run) => Effect.Effect<void, PipesError>;
    probe: (path: string, agent: typeof Agent.Type) => Effect.Effect<void, PipesError>;
    resume: (run: Run, report: Report) => Effect.Effect<number, PipesError>;
    setup: (cwd: string, command: ReadonlyArray<string>) => Effect.Effect<void, PipesError>;
    workspace: (directory: string, runId: string) => string;
  }
>()('pipes/Environment') {
  static layer = Layer.effect(
    Environment,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const gitOps = makeGit(spawner);
      const configuration = Effect.fn('Environment.configuration')(function* (repository: string) {
        const { args, executable } = selfCommand(['config', repository]);
        const output = yield* spawner.string(ChildProcess.make(executable, args));
        return yield* Schema.decodeEffect(Schema.fromJsonString(Config))(output);
      }, Effect.mapError(failure));
      const probe = Effect.fn('Environment.probe')(
        function* (path: string, agent: typeof Agent.Type) {
          yield* probeCodex({ ...agent, path });
        },
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const execute = Effect.fn('Environment.execute')(
        function* (input: Parameters<Environment['Service']['execute']>[0]) {
          let accepting = true;
          const mcp = yield* Effect.acquireRelease(
            Effect.try({
              catch: failure,
              try: () =>
                resultMcp((result) => {
                  if (!accepting) {
                    return Promise.reject(new Error('This attempt has ended.'));
                  }
                  return input.report(result);
                }),
            }),
            ({ server }) =>
              Effect.promise(async () => {
                accepting = false;
                await server.stop(true);
              }),
          );
          const session = yield* openCodex(
            { ...input.agent, path: input.path },
            { mcpServers: [mcp.configuration], update: input.update },
          );
          yield* input.session({ codexHome: codexHome(), sessionId: session.sessionId });
          yield* Effect.try({ catch: failure, try: () => input.update({ prompt: input.prompt }) });
          const response = yield* Effect.tryPromise({
            catch: failure,
            try: () =>
              session.connection.agent.request('session/prompt', {
                prompt: [{ text: input.prompt, type: 'text' }],
                sessionId: session.sessionId,
              }),
          });
          accepting = false;
          if (response.stopReason !== 'end_turn') {
            return yield* new PipesError({ message: `Agent ended with ${response.stopReason}.` });
          }
        },
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(failure),
      );
      const handoffSession = Effect.fn('Environment.handoffSession')(function* (run: Run) {
        const attempt = run.attempts.at(-1);
        const step = run.configuration.workflows[run.workflow]?.steps.find(
          (step) => step.name === attempt?.step,
        );
        if (!attempt?.sessionId || step?.agent.command) {
          return yield* new PipesError({
            message:
              'No resumable bundled Codex session yet. Custom ACP commands cannot be resumed by the bundled CLI.',
          });
        }
        return { codexHome: attempt.codexHome ?? codexHome(), sessionId: attempt.sessionId };
      });
      const resume = Effect.fn('Environment.resume')(
        function* (run: Run, report: Report) {
          const mcp = yield* Effect.acquireRelease(
            Effect.try({ catch: failure, try: () => resultMcp(report) }),
            ({ server }) => Effect.promise(() => server.stop(true)),
          );
          const resumeArgs = resumeArguments(run, mcp.configuration.url);
          const handle = yield* spawner.spawn(
            ChildProcess.make(resumeArgs[0]!, resumeArgs.slice(1), {
              cwd: run.workspace,
              detached: false,
              env: {
                CODEX_HOME: run.attempts.at(-1)!.codexHome!,
                PIPES_HANDOFF_TOKEN: mcp.configuration.headers[0]!.value.slice('Bearer '.length),
              },
              extendEnv: true,
              stderr: 'inherit',
              stdin: 'inherit',
              stdout: 'inherit',
            }),
          );
          return yield* handle.exitCode;
        },
        Effect.scoped,
        Effect.mapError(failure),
      );
      const setup = Effect.fn('Environment.setup')(
        function* (cwd: string, command: ReadonlyArray<string>) {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command[0]!, command.slice(1), {
              cwd,
              stderr: 'ignore',
              stdout: 'ignore',
            }),
          );
          if ((yield* handle.exitCode) !== 0) {
            return yield* new PipesError({
              message: 'Repository setup failed; no agent was started.',
            });
          }
        },
        Effect.scoped,
        Effect.mapError((error) =>
          error instanceof PipesError ? error : new PipesError({ message: String(error) }),
        ),
      );
      return Environment.of({
        ...gitOps,
        configuration,
        execute,
        handoffSession,
        probe,
        resume,
        setup,
      });
    }),
  );
}
