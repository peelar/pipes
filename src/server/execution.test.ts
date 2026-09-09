import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Deferred, Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodexFixture } from '../../test/codex-fixture';
import { Client } from '../client/connection';
import { Environment, resumeArguments } from './environment';
import { serve } from '../server';
import { Run } from '../protocol/pipes';
import { Store } from './store';
import { Execution } from './execution';

const git = async (cwd: string, ...args: Array<string>) => {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { stderr: 'pipe', stdout: 'pipe' });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return output.trim();
};

test('execution uses the supplied environment and waits for its worker cleanup before checkpointing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-environment-'));
  const events: Array<string> = [];
  const release = Deferred.makeUnsafe<void>();
  const configuration = {
    setup: ['setup'],
    workflows: {
      work: {
        steps: [
          {
            agent: { model: 'test', provider: 'codex' as const, reasoning: 'low' },
            name: 'work',
            prompt: 'Do the work',
          },
        ],
      },
    },
  };
  const environment = Environment.of({
    checkpoint: () =>
      Effect.sync(() => {
        expect(events.at(-1)).toBe('worker stopped');
        events.push('checkpoint');
        return 'result-revision';
      }),
    cleanup: () =>
      Effect.sync(() => {
        events.push('cleanup');
      }),
    configuration: () => Effect.succeed(configuration),
    execute: Effect.fn(function* (input) {
      expect(input.path).toBe('sandbox://run/workspace');
      expect(input.prompt).toContain('Do the work');
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push('worker stopped');
        }),
      );
      yield* input.session({ codexHome: '/sandbox/session', sessionId: 'session' });
      input.update({ prompt: input.prompt });
      yield* Effect.promise(() => input.report({ status: 'completed', summary: 'Result' }));
      yield* Deferred.await(release);
    }, Effect.scoped),
    exists: () => Effect.succeed(false),
    git: () => Effect.succeed('base-revision'),
    handoffSession: () => Effect.die('Unexpected handoff'),
    prepare: () =>
      Effect.sync(() => {
        events.push('prepare');
      }),
    probe: () =>
      Effect.sync(() => {
        events.push('probe');
      }),
    resume: () => Effect.die('Unexpected resume'),
    setup: () =>
      Effect.sync(() => {
        events.push('setup');
      }),
    workspace: () => 'sandbox://run/workspace',
  });
  const runtime = ManagedRuntime.make(
    Execution.layer(directory).pipe(
      Layer.provide(Layer.succeed(Environment, environment)),
      Layer.provideMerge(Store.layer(join(directory, 'pipes.sqlite'))),
      Layer.provide(BunServices.layer),
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const execution = yield* Execution;
        const repository = yield* store.register(process.cwd());
        for (const cancel of [true, false]) {
          events.length = 0;
          const task = yield* store.submit({
            brief: 'Work',
            repositoryId: repository.id,
            title: 'Test',
          });
          const run = yield* execution.start({ taskId: task.id });
          const waitForRun = (predicate: (run: Run) => boolean) =>
            store.watch.pipe(
              Stream.map((snapshot) => snapshot.runs?.find((current) => current.id === run.id)),
              Stream.filter((run): run is Run => !!run && predicate(run)),
              Stream.take(1),
              Stream.runCollect,
              Effect.map((runs) => runs[0]!),
              Effect.timeout('5 seconds'),
            );
          const reported = yield* waitForRun((run) => !!run.attempts[0]?.result);
          expect(reported.status).toBe('running');
          expect(events).toEqual(['probe', 'prepare', 'setup']);
          if (cancel) {
            yield* execution.cancel(task.id);
          } else {
            yield* Deferred.succeed(release, undefined);
          }
          const finished = yield* waitForRun((run) => run.workerStopped === true);
          expect(finished.status).toBe(cancel ? 'cancelled' : 'awaiting_acceptance');
          expect(finished.attempts[0]?.status).toBe(cancel ? 'interrupted' : 'completed');
          expect(finished.revision).toBe('result-revision');
          expect(readFileSync(finished.attempts[0]!.transcript, 'utf8')).toContain('Do the work');
          expect(events).toEqual([
            'probe',
            'prepare',
            'setup',
            'worker stopped',
            'checkpoint',
            ...(cancel ? [] : ['cleanup']),
          ]);
        }
      }),
    );
  } finally {
    await runtime.dispose();
    rmSync(directory, { force: true, recursive: true });
  }
});

test('server owns execution across client disconnects, validates outcomes, checkpoints, and stops workers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pipes-execution-'));
  const repository = join(directory, 'project');
  mkdirSync(join(repository, '.pipes'), { recursive: true });
  const fixture = writeCodexFixture(directory);
  await git(repository, 'init');
  await git(
    repository,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  );
  const reserve = Bun.serve({ fetch: () => new Response(), port: 0 });
  const port = reserve.port!;
  await reserve.stop(true);
  const connection = { directory, port, token: 'test', url: `http://127.0.0.1:${port}` };
  const serverRuntime = ManagedRuntime.make(BunServices.layer);
  const controller = new AbortController();
  let serving = serverRuntime
    .runPromise(serve(connection).pipe(Effect.scoped), { signal: controller.signal })
    .catch(() => {});
  let runtime = ManagedRuntime.make(Client.layer(connection));
  const call = <A, E>(f: (client: Client['Service']) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Client, f));
  const configure = (mode: string, setup?: Array<string>) =>
    writeFileSync(
      join(repository, '.pipes/config.ts'),
      `export default ${JSON.stringify({ setup, workflows: { work: { steps: ['implement', 'review'].map((name) => ({ agent: { command: [process.execPath, fixture, mode], model: 'large', provider: 'codex', reasoning: 'high' }, name, prompt: `Do ${name}` })) } } })};`,
    );
  const waitForRun = (id: string, predicate: (run: Run) => boolean) =>
    call((client) =>
      client.watch().pipe(
        Stream.map((snapshot) => snapshot.runs?.find((run) => run.id === id)),
        Stream.filter((run): run is Run => !!run && predicate(run)),
        Stream.take(1),
        Stream.runCollect,
        Effect.map((runs) => runs[0]!),
        Effect.timeout('8 seconds'),
      ),
    );
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await fetch(`${connection.url}/health`, { headers: { Authorization: 'Bearer test' } })
          .then((response) => response.ok)
          .catch(() => false)
      ) {
        break;
      }
      await Bun.sleep(20);
    }
    const registered = await call((client) => client.register({ path: repository }));
    const submit = () =>
      call((client) =>
        client.submit({
          brief: 'Captured request',
          repositoryId: registered.id,
          title: 'Execution test',
        }),
      );
    configure('execute-wait');
    const task = await submit();
    const run = await call((client) => client.start({ taskId: task.id }));
    await waitForRun(run.id, (run) => !!run.attempts[0]?.sessionId);
    await expect(serverRuntime.runPromise(serve(connection).pipe(Effect.scoped))).rejects.toThrow(
      'Cannot listen',
    );
    expect(
      (await call((client) => client.snapshot())).runs?.find((current) => current.id === run.id)
        ?.status,
    ).toBe('running');
    await expect(call((client) => client.start({ taskId: task.id }))).rejects.toThrow(
      'already has a run',
    );
    await runtime.dispose();
    // The requesting client is gone while the worker remains alive.
    expect(() =>
      process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0),
    ).not.toThrow();
    configure('execute-missing');
    writeFileSync(join(directory, 'release'), '');
    runtime = ManagedRuntime.make(Client.layer(connection));
    const completed = await waitForRun(run.id, (run) => run.status === 'awaiting_acceptance');
    expect(completed.attempts.map((attempt) => attempt.status)).toEqual(['completed', 'completed']);
    expect(completed.brief).toBe('Captured request');
    expect(completed.revision).toBeTruthy();
    expect(existsSync(completed.workspace)).toBe(false);
    expect(existsSync(join(repository, 'agent-change.txt'))).toBe(false);
    expect(readFileSync(completed.attempts[1]!.transcript, 'utf8')).toContain('Fixture result');
    expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow();
    for (const [mode, status] of [
      ['execute-missing', 'failed'],
      ['execute-crash', 'failed'],
      ['execute-blocked', 'blocked'],
    ] as const) {
      configure(mode);
      const task = await submit();
      const started = await call((client) => client.start({ taskId: task.id }));
      const finished = await waitForRun(started.id, (run) => run.status === status);
      expect(finished.attempts).toHaveLength(1);
      expect(finished.revision).toBeTruthy();
    }
    configure('execute-wait');
    rmSync(join(directory, 'release'));
    const stoppingTask = await submit();
    const stopping = await call((client) => client.start({ taskId: stoppingTask.id }));
    await waitForRun(stopping.id, (run) => !!run.attempts[0]?.sessionId);
    await expect(call((client) => client.jumpIn({ taskId: stoppingTask.id }))).rejects.toThrow(
      'Custom ACP',
    );
    await call((client) => client.stop({ taskId: stoppingTask.id }));
    const stopped = await waitForRun(stopping.id, (run) => run.status === 'interrupted');
    expect(stopped.revision).toBeTruthy();
    expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow();
    // Seed a resumable bundled session after the fixture worker has demonstrably stopped.
    const handoffStorage = ManagedRuntime.make(
      Store.layer(join(directory, 'pipes.sqlite')).pipe(Layer.provide(BunServices.layer)),
    );
    try {
      await handoffStorage.runPromise(
        Effect.flatMap(Store, (store) =>
          store.saveRun({
            ...stopped,
            configuration: {
              workflows: {
                work: {
                  steps: stopped.configuration.workflows.work!.steps.map((step) => ({
                    ...step,
                    agent: { model: 'large', provider: 'codex', reasoning: 'high' },
                  })),
                },
              },
            },
            workerStopped: false,
          }),
        ),
      );
    } finally {
      await handoffStorage.dispose();
    }
    await expect(call((client) => client.jumpIn({ taskId: stoppingTask.id }))).rejects.toThrow(
      'Cannot confirm',
    );
    const claims = await Promise.allSettled([
      call((client) => client.jumpIn({ confirmedStopped: true, taskId: stoppingTask.id })),
      call((client) => client.jumpIn({ confirmedStopped: true, taskId: stoppingTask.id })),
    ]);
    expect(
      claims.filter((claim) => claim.status === 'fulfilled'),
      JSON.stringify(claims),
    ).toHaveLength(1);
    const owned = (await call((client) => client.snapshot())).runs!.find(
      (run) => run.id === stopping.id,
    )!;
    expect(owned.status).toBe('human_owned');
    expect(owned.attempts.at(-1)?.sessionId).toBe(stopped.attempts.at(-1)?.sessionId);
    expect(owned.attempts).toHaveLength(2);
    expect(owned.handoffToken).toBeTruthy();
    const args = resumeArguments(owned, 'http://127.0.0.1:1234/mcp');
    expect(args.slice(1, 5)).toEqual([
      'resume',
      owned.attempts.at(-1)!.sessionId!,
      '--cd',
      owned.workspace,
    ]);
    const nativeHelp = Bun.spawn([process.execPath, args[0]!, 'resume', '--help'], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(await new Response(nativeHelp.stdout).text()).toContain('codex resume');
    expect(await nativeHelp.exited).toBe(0);
    await expect(call((client) => client.start({ taskId: stoppingTask.id }))).rejects.toThrow(
      'already has a run',
    );
    await expect(
      call((client) =>
        client.handoffClose({ successful: true, taskId: stoppingTask.id, token: 'stale' }),
      ),
    ).rejects.toThrow('ownership');
    writeFileSync(join(owned.workspace, 'human-change.txt'), 'interactive edit');
    await call((client) =>
      client.handoffReport({
        result: { status: 'completed', summary: 'Human reviewed changes.' },
        taskId: stoppingTask.id,
        token: owned.handoffToken!,
      }),
    );
    await expect(
      call((client) =>
        client.handoffReport({
          result: { status: 'completed', summary: 'Duplicate' },
          taskId: stoppingTask.id,
          token: owned.handoffToken!,
        }),
      ),
    ).rejects.toThrow('already reported');
    await call((client) =>
      client.handoffClose({
        successful: true,
        taskId: stoppingTask.id,
        token: owned.handoffToken!,
      }),
    );
    const held = (await call((client) => client.snapshot())).runs!.find(
      (run) => run.id === stopping.id,
    )!;
    expect(held.status).toBe('human_owned');
    expect(held.handoffToken).toBeUndefined();
    expect(held.attempts.at(-1)?.status).toBe('completed');
    expect(await git(held.workspace, 'status', '--porcelain')).toBe('');
    expect(held.revision).not.toBe(stopped.revision);
    const reopened = await call((client) => client.jumpIn({ taskId: stoppingTask.id }));
    expect(reopened.handoffToken).not.toBe(owned.handoffToken);
    await call((client) =>
      client.handoffClose({
        successful: false,
        taskId: stoppingTask.id,
        token: reopened.handoffToken!,
      }),
    );
    expect(
      (await call((client) => client.snapshot()))
        .runs!.find((run) => run.id === stopping.id)!
        .attempts.at(-1)?.status,
    ).toBe('interrupted');
    const cancellingTask = await submit();
    const cancelling = await call((client) => client.start({ taskId: cancellingTask.id }));
    await waitForRun(cancelling.id, (run) => !!run.attempts[0]?.sessionId);
    const beforeInspection = (await call((client) => client.snapshot())).runs?.find(
      (run) => run.id === cancelling.id,
    );
    expect(await call((client) => client.conversation({ taskId: cancellingTask.id }))).toContain(
      'Captured request',
    );
    expect(
      (await call((client) => client.snapshot())).runs?.find((run) => run.id === cancelling.id),
    ).toEqual(beforeInspection);
    await call((client) => client.cancel({ taskId: cancellingTask.id }));
    const cancelled = await waitForRun(cancelling.id, (run) => run.status === 'cancelled');
    expect(cancelled.revision).toBeTruthy();
    expect(cancelled.attempts).toHaveLength(1);
    expect(cancelled.attempts[0]?.status).toBe('interrupted');
    expect(() => process.kill(Number(readFileSync(join(directory, 'pid'), 'utf8')), 0)).toThrow();
    configure('execute-missing');
    const restartedCancellation = await call((client) =>
      client.start({ taskId: cancellingTask.id }),
    );
    expect(restartedCancellation.id).not.toBe(cancelling.id);
    expect(restartedCancellation.workspace).not.toBe(cancelling.workspace);
    expect(restartedCancellation.attempts).toHaveLength(0);
    await waitForRun(restartedCancellation.id, (run) => run.status === 'failed');
    expect(
      (await call((client) => client.snapshot())).runs?.filter(
        (run) => run.taskId === cancellingTask.id,
      ),
    ).toHaveLength(2);
    await expect(call((client) => client.cancel({ taskId: cancellingTask.id }))).rejects.toThrow(
      'Only ongoing',
    );
    configure('execute-report-wait');
    const reportedTask = await submit();
    const reportedRun = await call((client) => client.start({ taskId: reportedTask.id }));
    await waitForRun(reportedRun.id, (run) => !!run.attempts[0]?.result);
    await call((client) => client.cancel({ taskId: reportedTask.id }));
    const cancelledReport = await waitForRun(reportedRun.id, (run) => run.status === 'cancelled');
    expect(cancelledReport.attempts).toHaveLength(1);
    expect(cancelledReport.attempts[0]?.result?.status).toBe('completed');
    expect(cancelledReport.attempts[0]?.status).toBe('interrupted');
    configure('execute-missing', [process.execPath, '-e', 'process.exit(2)']);
    const setupTask = await submit();
    const setup = await call((client) => client.start({ taskId: setupTask.id }));
    const failedSetup = await waitForRun(setup.id, (run) => run.status === 'failed');
    expect(failedSetup.attempts).toHaveLength(0);
    expect(failedSetup.summary).toContain('Repository setup failed');
    const lockedHandoff = await call((client) => client.jumpIn({ taskId: stoppingTask.id }));
    await call((client) => client.shutdown());
    await serving;
    const storage = ManagedRuntime.make(
      Store.layer(join(directory, 'pipes.sqlite')).pipe(Layer.provide(BunServices.layer)),
    );
    try {
      await storage.runPromise(
        Effect.flatMap(Store, (store) =>
          store.saveRun({
            ...completed,
            attempts: [
              { ...completed.attempts[0]!, status: 'completed' },
              { ...completed.attempts[1]!, status: 'running' },
            ],
            status: 'running',
          }),
        ),
      );
    } finally {
      await storage.dispose();
    }
    const callsBeforeRestart = readFileSync(join(directory, 'calls.jsonl'), 'utf8');
    serving = serverRuntime
      .runPromise(serve(connection).pipe(Effect.scoped), { signal: controller.signal })
      .catch(() => {});
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await fetch(`${connection.url}/health`, { headers: { Authorization: 'Bearer test' } })
          .then((response) => response.ok)
          .catch(() => false)
      ) {
        break;
      }
      await Bun.sleep(20);
    }
    const recovered = await waitForRun(completed.id, (run) => run.status === 'interrupted');
    const recoveredHandoff = (await call((client) => client.snapshot())).runs!.find(
      (run) => run.id === stopping.id,
    )!;
    expect(recoveredHandoff.status).toBe('human_owned');
    expect(recoveredHandoff.handoffToken).toBe(lockedHandoff.handoffToken);
    await expect(call((client) => client.jumpIn({ taskId: stoppingTask.id }))).rejects.toThrow(
      'already has an interactive session',
    );
    await call((client) =>
      client.handoffClose({
        successful: false,
        taskId: stoppingTask.id,
        token: lockedHandoff.handoffToken!,
      }),
    );
    expect(recovered.attempts.map((attempt) => attempt.status)).toEqual([
      'completed',
      'interrupted',
    ]);
    expect(readFileSync(join(directory, 'calls.jsonl'), 'utf8')).toBe(callsBeforeRestart);
    writeFileSync(join(directory, 'release'), '');
    const restarted = await call((client) => client.start({ taskId: completed.taskId }));
    expect(restarted.id).toBe(completed.id);
    expect(restarted.configuration).toEqual(completed.configuration);
    expect(restarted.workspace).toBe(completed.workspace);
    const resumed = await waitForRun(
      completed.id,
      (run) => !['queued', 'running'].includes(run.status),
    );
    expect(resumed.status).toBe('awaiting_acceptance');
    expect(resumed.attempts.map((attempt) => attempt.status)).toEqual([
      'completed',
      'interrupted',
      'completed',
    ]);
  } finally {
    controller.abort();
    await serving;
    await runtime.dispose();
    await serverRuntime.dispose();
    rmSync(directory, { force: true, recursive: true });
  }
}, 30_000);
