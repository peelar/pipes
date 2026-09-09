import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from './connection';
import { PipesError, Run } from '../protocol/pipes';
import { resultMcp } from '../server/result-mcp';

export function resumeArguments(run: Run, url: string) {
  const attempt = run.attempts.at(-1)!;
  return [
    createRequire(fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp'))).resolve(
      '@openai/codex/bin/codex.js',
    ),
    'resume',
    attempt.sessionId!,
    '--cd',
    run.workspace,
    '-c',
    `mcp_servers.pipes_handoff.url=${JSON.stringify(url)}`,
    '-c',
    'mcp_servers.pipes_handoff.bearer_token_env_var="PIPES_HANDOFF_TOKEN"',
    `Interactive Pipes handoff: task ${run.taskId}, run ${run.id}, step ${attempt.step}, attempt ${attempt.id}. The detached worker has stopped. The human owns this step; wait for their instructions. Earlier conversation and workspace are preserved. Use the refreshed pipes_handoff report_result tool; the detached attempt's endpoint has expired. Reporting records an outcome, but does not start sibling steps. Do not push, publish, or merge. Closing Codex leaves the task held; the human must explicitly return control in Pipes.`,
  ];
}

export const jumpIn = Effect.fn('jumpIn')(function* (taskId: string, confirmedStopped = false) {
  if (!process.stdin.isTTY) {
    return yield* new PipesError({ message: 'Jump in requires an interactive terminal.' });
  }
  const client = yield* Client;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const context = yield* Effect.context<never>();
  let successful = false;
  const run = yield* Effect.acquireRelease(client.jumpIn({ confirmedStopped, taskId }), (run) =>
    client.handoffClose({ successful, taskId, token: run.handoffToken! }).pipe(
      Effect.mapError(
        (error) =>
          new PipesError({
            message: `Task remains locked: ${error.message}. After confirming Codex stopped, use pipes handoff-close ${taskId} --confirm-stopped.`,
          }),
      ),
      Effect.orDie,
    ),
  );
  const mcp = yield* Effect.acquireRelease(
    Effect.try({
      catch: (error) => new PipesError({ message: String(error) }),
      try: () =>
        resultMcp((result) =>
          Effect.runPromiseWith(context)(
            client.handoffReport({ result, taskId, token: run.handoffToken! }),
          ),
        ),
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  );
  const code = yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, resumeArguments(run, mcp.configuration.url), {
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
  }).pipe(Effect.scoped);
  successful = code === 0;
  if (!successful) {
    return yield* new PipesError({
      message: `Codex resume exited with ${code}. The task remains human-owned; jump in again or explicitly return control.`,
    });
  }
}, Effect.scoped);
