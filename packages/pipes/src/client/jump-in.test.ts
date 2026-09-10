import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Client } from '@pipes/protocol';
import { jumpIn } from './jump-in';
import { Run } from '@pipes/protocol';

test('native handoff inherits the terminal and closes ownership only after the child stops', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const events: Array<string> = [];
  let exitCode = 0;
  const run = new Run({
    attempts: [
      {
        codexHome: '/test/codex-home',
        id: 'attempt',
        sessionId: 'saved-session',
        status: 'interrupted',
        step: 'work',
        transcript: '/test/transcript',
      },
    ],
    baseRevision: 'base',
    branch: 'branch',
    brief: 'Work',
    configuration: {
      workflows: {
        work: {
          steps: [
            {
              agent: { model: 'test', provider: 'codex', reasoning: 'low' },
              name: 'work',
              prompt: 'Work',
            },
          ],
        },
      },
    },
    createdAt: '',
    handoffToken: 'owner',
    id: 'run',
    status: 'human_owned',
    summary: '',
    taskId: 'task',
    title: 'Work',
    workflow: 'work',
    workspace: process.cwd(),
  });
  const runtime = ManagedRuntime.make(
    Layer.merge(
      Layer.effect(
        Client,
        Effect.map(Client, (client) =>
          Client.of({
            ...client,
            handoffClose: ({ successful }) =>
              Effect.sync(() => {
                events.push(`close:${successful}`);
              }),
            jumpIn: () =>
              Effect.sync(() => {
                events.push('claim');
                return run;
              }),
          } as Client['Service']),
        ),
      ).pipe(
        Layer.provide(
          Client.layer({
            directory: process.cwd(),
            port: 1,
            token: 'test',
            url: 'http://127.0.0.1:1',
          }),
        ),
      ),
      Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) => ({
          ...spawner,
          spawn: (command: ChildProcess.Command) =>
            Effect.gen(function* () {
              expect(command._tag).toBe('StandardCommand');
              if (command._tag !== 'StandardCommand') {
                throw new Error('Expected a native command');
              }
              expect(command.args.slice(0, 4)).toEqual([
                'resume',
                'saved-session',
                '--cd',
                run.workspace,
              ]);
              expect(command.options).toMatchObject({
                cwd: run.workspace,
                detached: false,
                stderr: 'inherit',
                stdin: 'inherit',
                stdout: 'inherit',
              });
              expect(command.options.env).toMatchObject({ CODEX_HOME: '/test/codex-home' });
              events.push('spawn');
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  events.push('stopped');
                }),
              );
              return yield* spawner.spawn(
                ChildProcess.make(
                  exitCode === -1 ? '/missing/pipes-test-executable' : process.execPath,
                  ['-e', `process.exit(${exitCode})`],
                ),
              );
            }),
        })),
      ).pipe(Layer.provide(BunServices.layer)),
    ),
  );
  try {
    await runtime.runPromise(jumpIn('task'));
    expect(events).toEqual(['claim', 'spawn', 'stopped', 'close:true']);
    events.length = 0;
    exitCode = 17;
    await expect(runtime.runPromise(jumpIn('task'))).rejects.toThrow('exited with 17');
    expect(events).toEqual(['claim', 'spawn', 'stopped', 'close:false']);
    events.length = 0;
    exitCode = -1;
    await expect(runtime.runPromise(jumpIn('task'))).rejects.toThrow();
    expect(events).toEqual(['claim', 'spawn', 'stopped', 'close:false']);
    events.length = 0;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    await expect(runtime.runPromise(jumpIn('task'))).rejects.toThrow('interactive terminal');
    expect(events).toEqual([]);
  } finally {
    await runtime.dispose();
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor);
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  }
});
