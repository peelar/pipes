import { expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Deferred, Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Run } from '../protocol/pipes';
import { Environment } from './environment';
import { Execution } from './execution';
import { Store } from './store';

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
          expect(run.id).toHaveLength(8);
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
